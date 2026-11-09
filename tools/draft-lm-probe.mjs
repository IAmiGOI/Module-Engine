#!/usr/bin/env node
/**
 * Проба: видит ли маленькая языковая модель (distilgpt2, q8) «черновик закончен»?
 * Отличие от `draft-e5-probe.mjs`: вместо усреднённого вектора — вероятность того, что
 * реплика «User: …» здесь кончается (конец текста, перевод строки) и энтропия следующего токена.
 * Варианты: признаки (длина, знак, кавычка) / только LM / LM вместе с признаками.
 * Запуск: CUT_MODE=sentence node tools/draft-lm-probe.mjs (PROBE_LM — другая модель).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AutoModelForCausalLM, AutoTokenizer, Tensor, env } from '@huggingface/transformers';
// Без сети — из кеша библиотеки (PROBE_OFFLINE=1).
if (process.env.PROBE_OFFLINE) env.allowRemoteModels = false;
import { endsWithEnding, unclosedQuoteOrStar } from '../libraries/core/draft-readiness.js';

const MODEL_ID = process.env.PROBE_LM || 'Xenova/distilgpt2';
const MAX_TOKENS = 512;
const TAIL_TOKENS = 64;
const FOLDS = 5;
const L2 = Number(process.env.PROBE_L2) || 1e-3;
const EPOCHS = Number(process.env.PROBE_EPOCHS) || 250;
const LR = Number(process.env.PROBE_LR) || 0.05;
const SEED = 20261109;

const DEFAULT_CHAT_DIR = path.join(
    os.homedir(),
    'SillyTavern', 'data', 'default-user', 'chats', 'ReZero RPG',
);
const CHAT_DIR = process.env.CHAT_DIR || DEFAULT_CHAT_DIR;

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const random = mulberry32(SEED);

/** Все отправленные сообщения игрока из всех .jsonl папки, без повторов. */
function readUserMessages(dir) {
    const files = fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort();
    const seen = new Set();
    const messages = [];
    for (const file of files) {
        const raw = fs.readFileSync(path.join(dir, file), 'utf8');
        for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            let record;
            try {
                record = JSON.parse(line);
            } catch {
                continue;
            }
            if (record?.is_user !== true || typeof record.mes !== 'string') continue;
            const text = record.mes.trim();
            if (!text || seen.has(text)) continue;
            seen.add(text);
            messages.push(text);
        }
    }
    return messages;
}

/** Обрезка по границе слова в случайной точке 30–90 % длины. */
function cutAtWord(text, fraction) {
    const target = Math.max(1, Math.min(text.length - 1, Math.round(text.length * fraction)));
    let cut = target;
    while (cut > 1 && !/\s/.test(text[cut])) cut -= 1;
    if (cut <= 1 && target > 1) {
        cut = target;
        while (cut < text.length - 1 && !/\s/.test(text[cut])) cut += 1;
    }
    const out = text.slice(0, cut).trimEnd();
    return out || text.slice(0, target).trimEnd();
}

/** Границы законченных предложений внутри текста (после . ! ? … или закрытой кавычки/звёздочки) — там игрок и делает паузу. */
function sentenceCuts(text) {
    const cuts = [];
    const pattern = /[.!?…]["”*)]?(?=\s)|["”*](?=\s)/g;
    let match;
    while ((match = pattern.exec(text))) {
        const end = match.index + match[0].length;
        if (end >= text.length * 0.2 && end <= text.length - 15) cuts.push(end);
    }
    return cuts;
}

function buildExamples(messages) {
    const examples = [];
    // CUT_MODE=sentence: отрицательный пример — сообщение, оборванное на конце законченного предложения;
    // одно предложение без внутренней границы — пропускается.
    const sentence = process.env.CUT_MODE === 'sentence';
    messages.forEach((text, group) => {
        if (sentence) {
            const cuts = sentenceCuts(text);
            if (!cuts.length) return;
            examples.push({ group, label: 1, text });
            examples.push({ group, label: 0, text: text.slice(0, cuts[Math.floor(random() * cuts.length)]).trimEnd() });
            return;
        }
        const fraction = 0.3 + random() * 0.6;
        examples.push({ group, label: 1, text });
        examples.push({ group, label: 0, text: cutAtWord(text, fraction) });
    });
    return examples;
}

function nowMs() {
    return Number(process.hrtime.bigint()) / 1e6;
}

const LM_TOKENS = 128;

async function loadModel() {
    const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
    const model = await AutoModelForCausalLM.from_pretrained(MODEL_ID, { dtype: 'q8' });
    return { tokenizer, model };
}

/**
 * Признаки языковой модели по концу черновика: насколько вероятно, что реплика здесь кончается.
 * Реплика подаётся как строка диалога «User: …»; смотрим следующий токен после неё:
 * конец текста, перевод строки, двойной перевод строки и неуверенность (энтропия).
 */
async function lmFeatures({ tokenizer, model }, text) {
    const ids = tokenizer.encode(`User: ${text}`, { add_special_tokens: false }).slice(-LM_TOKENS);
    const input_ids = new Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]);
    const attention_mask = new Tensor('int64', BigInt64Array.from(ids.map(() => 1n)), [1, ids.length]);
    const output = await model({ input_ids, attention_mask });
    const [, seq, vocab] = output.logits.dims;
    const row = output.logits.data.subarray((seq - 1) * vocab, seq * vocab);
    let max = -Infinity;
    for (const value of row) if (value > max) max = value;
    let sum = 0;
    for (const value of row) sum += Math.exp(value - max);
    const logZ = max + Math.log(sum);
    let entropy = 0;
    for (const value of row) { const p = Math.exp(value - logZ); if (p > 1e-12) entropy -= p * Math.log(p); }
    const logp = id => row[id] - logZ;
    const eos = tokenizer.model?.tokens_to_ids?.get?.('<|endoftext|>') ?? 50256;
    const newline = tokenizer.encode('\n', { add_special_tokens: false })[0];
    const paragraph = tokenizer.encode('\n\n', { add_special_tokens: false })[0];
    return [logp(eos), logp(newline), logp(paragraph), entropy];
}

function baselineFeatures(text) {
    return [Math.log2(1 + text.length), endsWithEnding(text) ? 1 : 0, unclosedQuoteOrStar(text) ? 1 : 0];
}

function standardizeFit(rows) {
    const dim = rows[0].length;
    const mean = new Float64Array(dim);
    const std = new Float64Array(dim);
    for (const row of rows) for (let d = 0; d < dim; d += 1) mean[d] += row[d];
    for (let d = 0; d < dim; d += 1) mean[d] /= rows.length;
    for (const row of rows) for (let d = 0; d < dim; d += 1) {
        const value = row[d] - mean[d];
        std[d] += value * value;
    }
    for (let d = 0; d < dim; d += 1) std[d] = Math.sqrt(std[d] / rows.length) || 1;
    return { mean, std };
}

function applyStandardization(row, { mean, std }) {
    const out = new Float64Array(row.length);
    for (let d = 0; d < row.length; d += 1) out[d] = (row[d] - mean[d]) / std[d];
    return out;
}

const sigmoid = z => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/** Логистическая регрессия с L2, полный батч, Adam — детерминированно. */
function trainLogistic(rows, labels, { l2 = L2, epochs = EPOCHS, lr = LR } = {}) {
    const n = rows.length;
    const dim = rows[0].length;
    const weights = new Float64Array(dim);
    const m = new Float64Array(dim);
    const v = new Float64Array(dim);
    const grad = new Float64Array(dim);
    let bias = 0;
    let mBias = 0;
    let vBias = 0;
    const beta1 = 0.9;
    const beta2 = 0.999;
    const eps = 1e-8;
    for (let epoch = 1; epoch <= epochs; epoch += 1) {
        grad.fill(0);
        let gradBias = 0;
        for (let i = 0; i < n; i += 1) {
            const row = rows[i];
            let z = bias;
            for (let d = 0; d < dim; d += 1) z += weights[d] * row[d];
            const error = sigmoid(z) - labels[i];
            for (let d = 0; d < dim; d += 1) grad[d] += error * row[d];
            gradBias += error;
        }
        const biasFix1 = 1 - beta1 ** epoch;
        const biasFix2 = 1 - beta2 ** epoch;
        for (let d = 0; d < dim; d += 1) {
            grad[d] = grad[d] / n + l2 * weights[d];
            m[d] = beta1 * m[d] + (1 - beta1) * grad[d];
            v[d] = beta2 * v[d] + (1 - beta2) * grad[d] * grad[d];
            weights[d] -= lr * (m[d] / biasFix1) / (Math.sqrt(v[d] / biasFix2) + eps);
        }
        gradBias /= n;
        mBias = beta1 * mBias + (1 - beta1) * gradBias;
        vBias = beta2 * vBias + (1 - beta2) * gradBias * gradBias;
        bias -= lr * (mBias / biasFix1) / (Math.sqrt(vBias / biasFix2) + eps);
    }
    return { weights, bias };
}

const scoreOf = (model, row) => {
    let z = model.bias;
    for (let d = 0; d < row.length; d += 1) z += model.weights[d] * row[d];
    return sigmoid(z);
};

/** AUC через ранги (Mann–Whitney), с половинными рангами при равенстве. */
function aucOf(scores, labels) {
    const order = scores.map((score, index) => ({ score, label: labels[index] }))
        .sort((a, b) => a.score - b.score);
    const ranks = new Float64Array(order.length);
    let index = 0;
    while (index < order.length) {
        let end = index + 1;
        while (end < order.length && order[end].score === order[index].score) end += 1;
        const rank = (index + 1 + end) / 2;
        for (let k = index; k < end; k += 1) ranks[k] = rank;
        index = end;
    }
    let positives = 0;
    let rankSum = 0;
    for (let i = 0; i < order.length; i += 1) {
        if (order[i].label === 1) {
            positives += 1;
            rankSum += ranks[i];
        }
    }
    const negatives = order.length - positives;
    if (!positives || !negatives) return 0.5;
    return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

function crossValidate(rows, labels, groups) {
    let correct = 0;
    let total = 0;
    const allScores = [];
    const allLabels = [];
    for (let fold = 0; fold < FOLDS; fold += 1) {
        const trainRows = [];
        const trainLabels = [];
        const testRows = [];
        const testLabels = [];
        for (let i = 0; i < rows.length; i += 1) {
            if (groups[i] % FOLDS === fold) {
                testRows.push(rows[i]);
                testLabels.push(labels[i]);
            } else {
                trainRows.push(rows[i]);
                trainLabels.push(labels[i]);
            }
        }
        const scaling = standardizeFit(trainRows);
        const trainScaled = trainRows.map(row => applyStandardization(row, scaling));
        const testScaled = testRows.map(row => applyStandardization(row, scaling));
        const model = trainLogistic(trainScaled, trainLabels);
        for (let i = 0; i < testScaled.length; i += 1) {
            const score = scoreOf(model, testScaled[i]);
            allScores.push(score);
            allLabels.push(testLabels[i]);
            if ((score >= 0.5 ? 1 : 0) === testLabels[i]) correct += 1;
            total += 1;
        }
    }
    return { accuracy: correct / total, auc: aucOf(allScores, allLabels) };
}

function formatMs(value) {
    return `${value.toFixed(1)} ms`;
}

async function main() {
    if (!fs.existsSync(CHAT_DIR)) throw new Error(`chat directory not found: ${CHAT_DIR}`);
    const messages = readUserMessages(CHAT_DIR);
    if (messages.length < 20) throw new Error(`too few messages: ${messages.length}`);
    const examples = buildExamples(messages);
    console.log(`messages: ${messages.length}, examples: ${examples.length}`);

    console.log(`loading ${MODEL_ID} (q8)...`);
    const runtime = await loadModel();

    for (const text of messages.slice(0, 2)) await lmFeatures(runtime, text);
    const cache = new Map();
    const times = [];
    const rows = [];
    for (let index = 0; index < examples.length; index += 1) {
        const example = examples[index];
        let lm = cache.get(example.text);
        if (!lm) {
            const started = nowMs();
            lm = await lmFeatures(runtime, example.text);
            times.push(nowMs() - started);
            cache.set(example.text, lm);
        }
        rows.push({ lm, extras: baselineFeatures(example.text), label: example.label, group: example.group });
        if ((index + 1) % 200 === 0) console.log(`examples: ${index + 1}/${examples.length}`);
    }
    const labels = rows.map(item => item.label);
    const groups = rows.map(item => item.group);
    const rowsExtras = rows.map(item => Float64Array.from(item.extras));
    const rowsE5 = rows.map(item => Float64Array.from(item.lm));
    const rowsBoth = rows.map(item => Float64Array.from([...item.lm, ...item.extras]));

    const results = {
        l2: L2,
        epochs: EPOCHS,
        learningRate: LR,
        messages: messages.length,
        examples: examples.length,
        positives: labels.filter(label => label === 1).length,
        negatives: labels.filter(label => label === 0).length,
        vectors: cache.size,
        vectorMsMean: times.reduce((sum, value) => sum + value, 0) / times.length,
        vectorMsMedian: [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)],
        featureVariants: {
            extras: crossValidate(rowsExtras, labels, groups),
            lm: crossValidate(rowsE5, labels, groups),
            both: crossValidate(rowsBoth, labels, groups),
        },
    };
    results.aucGainBothOverExtras = results.featureVariants.both.auc - results.featureVariants.extras.auc;
    results.thresholdPassed = results.aucGainBothOverExtras >= 0.03;

    console.log(JSON.stringify(results, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
