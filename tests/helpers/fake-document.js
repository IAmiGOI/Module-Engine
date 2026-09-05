/**
 * A minimal but real fake `document` — real tree operations (append/remove/
 * replaceWith), a real attribute map, real event listener bookkeeping.
 * Scoped to exactly what services/dom.js calls; not a general-purpose DOM
 * harness. Shared between tests/dom-service.test.js and
 * tests/final-ui-pc.test.js (built once for the first, extracted here once
 * the second needed the exact same thing — same practice Alpha's own
 * tests/helpers/fake-dom.js followed).
 */
export class FakeElement {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.parent = null;
        this.attributes = {};
        this.style = {};
        this.className = '';
        this.value = undefined;
        this.checked = undefined;
        this._listeners = new Map();
        this._clicked = 0;
    }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(type, fn) { this._listeners.set(type, fn); }
    removeEventListener(type, fn) { if (this._listeners.get(type) === fn) this._listeners.delete(type); }
    append(child) { child.parent?._detach(child); this.children.push(child); child.parent = this; }
    remove() { this.parent?._detach(this); }
    // Real anchor-download flow (services/file.js) never dispatches a real
    // click event through this fake tree — just records that it happened,
    // which is all a test needs to assert the Service actually triggered one.
    click() { this._clicked += 1; }
    replaceWith(other) {
        const parent = this.parent;
        if (!parent) return;
        parent.children[parent.children.indexOf(this)] = other;
        other.parent = parent;
        this.parent = null;
    }
    _detach(child) {
        const i = this.children.indexOf(child);
        if (i >= 0) this.children.splice(i, 1);
        child.parent = null;
    }
}

export class FakeTextNode {
    constructor(text) { this.text = text; this.parent = null; }
    remove() { this.parent?._detach(this); }
}

export function makeFakeDocument() {
    return {
        body: new FakeElement('body'),
        createElement: tag => new FakeElement(tag),
        createTextNode: text => new FakeTextNode(text),
    };
}
