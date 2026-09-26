
/** Освобождение тел сообщений и бюджет памяти под текстуры. */
export function installBodyCache(ctx) {
    const { s, rasterizedText, physicalTextureSize, mirrors, bodyImages, bodyUse, textureHome, bodyHeights, textureBudgetBytes, serviceOrNull } = ctx;

    async function forgetBody(mesid) {
        const mirror = mirrors.get(mesid);
        if (mirror) {
            await serviceOrNull('dom.remove', { node: mirror });
            mirrors.delete(mesid);
        }
        await serviceOrNull('webglChat.releaseTexture', { canvas: textureHome.get(mesid) ?? s.canvas, textureId: mesid });
        textureHome.delete(mesid);
        rasterizedText.delete(mesid);
        physicalTextureSize.delete(mesid);
        bodyUse.delete(mesid);
        bodyImages.delete(mesid);
        bodyHeights.delete(mesid);
    }

    async function forgetMesid(mesid) {
        await ctx.forgetBody(mesid);
        await ctx.forgetRowChrome(mesid);
    }

    function textureBytes() {
        let total = 0;
        for (const size of physicalTextureSize.values()) total += size.width * size.height * 4;
        return total;
    }

    /** Вытесняет самые давние тела вне окна, пока не влезем в бюджет. */
    async function enforceBudget(protectedSet) {
        if (textureBudgetBytes == null) return;
        for (const mesid of [...bodyUse.keys()]) {
            if (ctx.textureBytes() <= textureBudgetBytes) break;
            if (protectedSet.has(mesid)) continue;
            await ctx.forgetBody(mesid);
        }
    }

    Object.assign(ctx, { forgetBody, forgetMesid, textureBytes, enforceBudget });
}
