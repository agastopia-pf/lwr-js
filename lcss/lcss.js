/**
 * LuaCSS Compiler
 * Compiles Lua-inspired syntax into CSS.
 *
 * Supported syntax:
 *
 *   body = {
 *     background = color.hex("#ff6b6b"),
 *     background = color.rgb(255, 107, 107),
 *     background = color.rgba(255, 107, 107, 0.5),
 *     background = color.hsl(0, 100, 67),
 *     background = color.hsla(0, 100, 67, 0.5),
 *     background = color.color3(1, 0.42, 0.42),  -- Roblox-style 0-1 floats
 *     background = 0xff6b6b,                      -- bare hex literal
 *     opacity = 0.8,                              -- bare number
 *     font_size = "2rem",                         -- string value
 *
 *     hover = function()
 *       opacity = 0.8
 *       color = color.hex("#fff")
 *     end,
 *
 *     focus = function() ... end,
 *     active = function() ... end,
 *     before = function() ... end,   -- ::before
 *     after  = function() ... end,   -- ::after
 *
 *     h1 = {                         -- nesting
 *       font_size = "1.5rem",
 *     },
 *
 *     ["&:nth-child(2)"] = {         -- arbitrary selector nesting
 *       color = color.hex("#fff"),
 *     },
 *   }
 *
 *  Rules:
 *   - Property names use underscores → converted to hyphens (font_size → font-size)
 *   - Bare numbers are emitted as-is  (opacity = 0.8 → opacity: 0.8)
 *   - Bare hex literals (0xRRGGBB)    → #rrggbb
 *   - Pseudo-states (hover/focus/etc) use :pseudo, before/after use ::pseudo
 *   - Nesting resolves to "parent child" unless child starts with & or : 
 */

// ─── LuaCSS Loader ───────────────────────────────────────────────────────────

(function () {
  const overlay = document.createElement('div');
  overlay.id = '__luacss-loader';
  overlay.style.cssText = ` 
    position: fixed; inset: 0; z-index: 999999;
    font-family: monospace; font-size: 1rem;
  `;

  const line = document.createElement('div');
  line.textContent = 'Preparing LuaCSS';
  overlay.appendChild(line);
  document.documentElement.appendChild(overlay);

  window.__luacss_loaderLine = line;
  window.__luacss_overlay = overlay;
})();



// ─── Tokenizer ────────────────────────────────────────────────────────────────

const TOKEN = {
  COMMENT: 'comment',
  STRING:  'string',
  HEX:     'hex',
  NUMBER:  'number',
  IDENT:   'ident',
  PUNCT:   'punct',
  WS:      'ws',
};

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const ch = (n = 0) => src[i + n] ?? '';

  while (i < src.length) {
    // -- comment
    if (ch() === '-' && ch(1) === '-') {
      let j = i;
      while (i < src.length && src[i] !== '\n') i++;
      tokens.push({ t: TOKEN.COMMENT, v: src.slice(j, i) });
      continue;
    }

    // whitespace (including newlines)
    if (/\s/.test(ch())) {
      let j = i;
      while (i < src.length && /\s/.test(src[i])) i++;
      tokens.push({ t: TOKEN.WS, v: src.slice(j, i) });
      continue;
    }

    // 0xHEX literal
    if (ch() === '0' && (ch(1) === 'x' || ch(1) === 'X')) {
      let j = i; i += 2;
      while (i < src.length && /[0-9a-fA-F]/.test(src[i])) i++;
      tokens.push({ t: TOKEN.HEX, v: src.slice(j, i) });
      continue;
    }

    // string (single or double quoted)
    if (ch() === '"' || ch() === "'") {
      const q = src[i++];
      let v = '';
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i++;
        v += src[i++];
      }
      i++; // closing quote
      tokens.push({ t: TOKEN.STRING, v });
      continue;
    }

    // number (integer or float, optional sign and CSS unit suffix)
    if (
      /[0-9]/.test(ch()) ||
      (ch() === '.' && /[0-9]/.test(ch(1))) ||
      ((ch() === '-' || ch() === '+') && (/[0-9]/.test(ch(1)) || (ch(1) === '.' && /[0-9]/.test(ch(2)))))
    ) {
      let j = i;
      if (src[i] === '-' || src[i] === '+') i++;
      while (i < src.length && /[0-9.]/.test(src[i])) i++;
      let unit = '';
      while (i < src.length && /[a-zA-Z%]/.test(src[i])) unit += src[i++];
      tokens.push({ t: TOKEN.NUMBER, v: src.slice(j, i - unit.length), unit });
      continue;
    }

    // identifier
    if (/[a-zA-Z_]/.test(ch())) {
      let j = i;
      while (i < src.length && /[a-zA-Z0-9_-]/.test(src[i])) i++;
      tokens.push({ t: TOKEN.IDENT, v: src.slice(j, i) });
      continue;
    }

    // single-character punctuation
    tokens.push({ t: TOKEN.PUNCT, v: src[i++] });
  }

  return tokens;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

// Pseudo-states that map to CSS pseudo-classes
const PSEUDO_CLASS = new Set([
  'hover', 'focus', 'active', 'visited', 'disabled', 'checked',
  'placeholder', 'first_child', 'last_child', 'nth_child',
  'first_of_type', 'last_of_type', 'focus_within', 'focus_visible',
  'not', 'root', 'empty', 'link', 'enabled', 'read_only', 'read_write',
]);

// Pseudo-elements (:: prefix)
const PSEUDO_ELEMENT = new Set(['before', 'after', 'first_line', 'first_letter', 'selection', 'placeholder']);

// Lua-style underscore names → CSS hyphenated names
const PSEUDO_NAME_MAP = {
  first_child:   'first-child',
  last_child:    'last-child',
  nth_child:     'nth-child',
  first_of_type: 'first-of-type',
  last_of_type:  'last-of-type',
  focus_within:  'focus-within',
  focus_visible: 'focus-visible',
  read_only:     'read-only',
  read_write:    'read-write',
  first_line:    'first-line',
  first_letter:  'first-letter',
};

function isPseudo(name) {
  return PSEUDO_CLASS.has(name) || PSEUDO_ELEMENT.has(name);
}

function pseudoSelector(parent, name) {
  const cssName = PSEUDO_NAME_MAP[name] ?? name;
  const prefix = PSEUDO_ELEMENT.has(name) ? '::' : ':';
  return parent + prefix + cssName;
}

function resolveSelector(parent, child) {
  // &  → replace & with parent (e.g. "&:nth-child(2)")
  if (child.includes('&')) return child.replace(/&/g, parent);
  // : or :: → append directly (e.g. ":not(.foo)")
  if (child.startsWith(':')) return parent + child;
  // default → parent descendant
  return parent + ' ' + child;
}

class Parser {
  constructor(src) {
    this.tokens = tokenize(src).filter(t => t.t !== TOKEN.WS && t.t !== TOKEN.COMMENT);
    this.pos    = 0;
    this.errors = [];
  }

  peek(n = 0)  { return this.tokens[this.pos + n]; }
  eat()        { return this.tokens[this.pos++]; }
  eof()        { return this.pos >= this.tokens.length; }

  expect(val) {
    const t = this.peek();
    if (!t || t.v !== val) {
      this.errors.push(`Expected '${val}' but got '${t?.v ?? 'EOF'}' (pos ${this.pos})`);
      return null;
    }
    return this.eat();
  }

  tokenToValuePiece(t) {
    if (!t) return '';
    if (t.t === TOKEN.STRING) return `"${t.v}"`;
    if (t.t === TOKEN.NUMBER) return t.v + (t.unit ?? '');
    if (t.t === TOKEN.HEX) return '#' + t.v.slice(2).padStart(6, '0');
    return t.v;
  }

  shouldStopValue(depth) {
    const t = this.peek();
    if (!t) return true;
    if (depth.paren === 0 && depth.brack === 0 && depth.brace === 0) {
      if (t.v === ',' || t.v === '}' || t.v === 'end') return true;
      if (t.t === TOKEN.IDENT && this.peek(1)?.v === '=') return true;
    }
    return false;
  }

  // ── color.TYPE(args) → CSS color string ──────────────────────────
  parseColor() {
    this.eat();          // 'color'
    this.expect('.');
    const fn = this.eat()?.v ?? '';
    this.expect('(');

    const args = [];
    while (!this.eof() && this.peek()?.v !== ')') {
      const t = this.eat();
      if (t.v === ',') continue;
      if (t.t === TOKEN.STRING) args.push(t.v);
      else if (t.t === TOKEN.NUMBER) args.push(Number(t.v));
      else if (t.t === TOKEN.HEX) args.push(t.v);
      else args.push(t.v);
    }
    this.expect(')');

    switch (fn) {
      case 'hex': {
        const raw = String(args[0] ?? '000000');
        return raw.startsWith('#') ? raw : '#' + raw;
      }
      case 'rgb':
        return `rgb(${args.slice(0, 3).join(', ')})`;
      case 'rgba':
        return `rgba(${args.slice(0, 4).join(', ')})`;
      case 'hsl':
        return `hsl(${args[0]}, ${args[1]}%, ${args[2]}%)`;
      case 'hsla':
        return `hsla(${args[0]}, ${args[1]}%, ${args[2]}%, ${args[3]})`;
      case 'color3': {
        // Roblox Color3: 0–1 float → 0–255 int
        const r = Math.round((+args[0] || 0) * 255);
        const g = Math.round((+args[1] || 0) * 255);
        const b = Math.round((+args[2] || 0) * 255);
        return `rgb(${r}, ${g}, ${b})`;
      }
      default:
        this.errors.push(`Unknown color function: color.${fn}`);
        return '#000000';
    }
  }

  // ── Parse a CSS value (RHS of assignment) ────────────────────────
  parseValue() {
    const t = this.peek();
    if (!t) return '';

    // color.xxx(...)
    if (t.t === TOKEN.IDENT && t.v === 'color' && this.peek(1)?.v === '.') {
      return this.parseColor();
    }

    if (t.t === TOKEN.IDENT && (this.peek(1)?.v === '=' || this.peek(1)?.v === '{')) return '';
    if (t.t === TOKEN.IDENT && (t.v === 'end' || t.v === 'function')) return '';

    const depth = { paren: 0, brack: 0, brace: 0 };
    let val = '';
    let prev = null;

    while (!this.eof() && !this.shouldStopValue(depth)) {
      const n = this.peek();
      const piece = this.tokenToValuePiece(n);

      const prevPiece = prev ? this.tokenToValuePiece(prev) : '';
      const next = this.peek(1);
      const nextIsWordLike = n.t === TOKEN.IDENT || n.t === TOKEN.NUMBER || n.t === TOKEN.STRING || n.t === TOKEN.HEX;
      const prevIsWordLike = prev && (prev.t === TOKEN.IDENT || prev.t === TOKEN.NUMBER || prev.t === TOKEN.STRING || prev.t === TOKEN.HEX);
      const nextTokenIsWordLike = next && (next.t === TOKEN.IDENT || next.t === TOKEN.NUMBER || next.t === TOKEN.STRING || next.t === TOKEN.HEX);
      const prevCanMath = prev && (prevIsWordLike || prevPiece === ')' || prevPiece === ']');
      const nextCanMath = next && (nextTokenIsWordLike || next.v === '(');
      const isMathOperator = ['+', '-'].includes(piece) && prevCanMath && nextCanMath;
      const needsSpace = prev && (
        (prevIsWordLike && nextIsWordLike) ||
        (prevPiece === ')' && nextIsWordLike)
      );

      if (isMathOperator) {
        if (val && !val.endsWith(' ')) val += ' ';
        val += piece;
        if (next && next.v !== ')' && next.v !== ',' && next.v !== '}' && next.v !== 'end') val += ' ';
      } else {
        if (needsSpace) val += ' ';
        val += piece;
      }

      if (n.v === '(') depth.paren++;
      else if (n.v === ')') depth.paren = Math.max(0, depth.paren - 1);
      else if (n.v === '[') depth.brack++;
      else if (n.v === ']') depth.brack = Math.max(0, depth.brack - 1);
      else if (n.v === '{') depth.brace++;
      else if (n.v === '}') depth.brace = Math.max(0, depth.brace - 1);

      prev = this.eat();
    }

    return val.trim();
  }

  // ── Parse: function() ... end → [{prop, value}] ──────────────────
  parseFunctionBlock() {
    this.expect('function');
    this.expect('(');
    this.expect(')');

    const props = [];
    while (!this.eof() && this.peek()?.v !== 'end') {
      const t = this.peek();
      if (!t) break;
      if (t.t !== TOKEN.IDENT) { this.eat(); continue; }

      const key = this.eat().v;
      if (this.peek()?.v !== '=') {
        if (this.peek()?.v === ',') this.eat();
        continue;
      }
      this.eat(); // =

      const value = this.parseValue();
      if (value !== '') {
        props.push({ prop: key.replace(/_/g, '-'), value });
      }
      if (this.peek()?.v === ',') this.eat();
    }
    this.expect('end');
    return props;
  }

  // ── Parse: { ... } → { props, children } ─────────────────────────
  parseBlock(selectorPath) {
    this.expect('{');
    const props    = [];
    const children = [];

    while (!this.eof() && this.peek()?.v !== '}') {
      const t = this.peek();
      if (!t) break;

      // ["arbitrary selector"] = { ... }
      if (t.v === '[') {
        this.eat(); // [
        let sel = '';
        if (this.peek()?.t === TOKEN.STRING) sel = this.eat().v;
        this.expect(']');
        this.expect('=');
        if (this.peek()?.v === '{') {
          const childSel = resolveSelector(selectorPath, sel);
          const result   = this.parseBlock(childSel);
          children.push({ selector: childSel, ...result });
        }
        if (this.peek()?.v === ',') this.eat();
        continue;
      }

      if (t.t !== TOKEN.IDENT) { this.eat(); continue; }

      const key = this.eat().v;

      if (this.peek()?.v !== '=') {
        if (this.peek()?.v === ',') this.eat();
        continue;
      }
      this.eat(); // =

      // pseudo-state: hover/focus/etc = function() ... end
      if (isPseudo(key) && this.peek()?.v === 'function') {
        const fnProps  = this.parseFunctionBlock();
        const pseudoSel = pseudoSelector(selectorPath, key);
        children.push({ selector: pseudoSel, props: fnProps, children: [] });
        if (this.peek()?.v === ',') this.eat();
        continue;
      }

      // nested block: ident = { ... }
      if (this.peek()?.v === '{') {
        const childSel = resolveSelector(selectorPath, key.replace(/_/g, '-'));
        const result   = this.parseBlock(childSel);
        children.push({ selector: childSel, ...result });
        if (this.peek()?.v === ',') this.eat();
        continue;
      }

      // plain property
      const value = this.parseValue();
      if (value !== '') {
        props.push({ prop: key.replace(/_/g, '-'), value });
      }
      if (this.peek()?.v === ',') this.eat();
    }

    this.expect('}');
    return { props, children };
  }

  // ── Top-level parse ───────────────────────────────────────────────
  parse() {
    const rules = [];

    while (!this.eof()) {
      const t = this.peek();
      if (!t) break;

      let selector = '';
      if (t.t === TOKEN.IDENT) {
        selector = this.eat().v;
      } else if (t.v === '[') {
        this.eat();
        if (this.peek()?.t === TOKEN.STRING) selector = this.eat().v;
        this.expect(']');
      } else {
        this.eat();
        continue;
      }

      if (this.peek()?.v !== '=') continue;
      this.eat(); // =
      if (this.peek()?.v !== '{') continue;

      const { props, children } = this.parseBlock(selector);

      if (props.length > 0) rules.push({ selector, props });
      collectChildren(children, rules);
    }

    return rules;
  }
}

function collectChildren(children, rules) {
  for (const child of children) {
    if (child.props.length > 0) rules.push({ selector: child.selector, props: child.props });
    if (child.children?.length > 0) collectChildren(child.children, rules);
  }
}

// ─── Emitter ──────────────────────────────────────────────────────────────────

function emit(rules) {
  return rules
    .map(rule => {
      const decls = rule.props
        .map(({ prop, value }) => `  ${prop}: ${value};`)
        .join('\n');
      return `${rule.selector} {\n${decls}\n}`;
    })
    .join('\n\n');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compile a LuaCSS string into a CSS string.
 *
 * @param {string} src  - LuaCSS source code
 * @returns {{ css: string|null, errors: string[] }}
 */
function compileLuaCSS(src) {
  // Inside compileLuaCSS(), right before:  const parser = new Parser(src);
  if (window.__luacss_loaderLine) window.__luacss_loaderLine.textContent = 'Compiling...';
  const parser = new Parser(src);
  const rules  = parser.parse();

  if (parser.errors.length > 0 && rules.length === 0) {
		// Inside compileLuaCSS(), right before the return statement at the very end
if (window.__luacss_overlay) {
  window.__luacss_loaderLine.textContent = 'compiled!';
  setTimeout(() => {
    window.__luacss_overlay.style.opacity = '0';
    setTimeout(() => window.__luacss_overlay.remove(), 300);
  }, 400);
}
    return { css: null, errors: parser.errors };
  }

  if (window.__luacss_overlay) {
  window.__luacss_loaderLine.textContent = 'compiled!';
  setTimeout(() => {
    window.__luacss_overlay.style.opacity = '0';
    setTimeout(() => window.__luacss_overlay.remove(), 300);
  }, 400);
  }
  return {
    css:    emit(rules),
    errors: parser.errors,  // non-fatal warnings
  };
}

// ─── Export ───────────────────────────────────────────────────────────────────

// Works as ES module, CommonJS, or plain <script> tag
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { compileLuaCSS };
} else if (typeof window !== 'undefined') {
  window.LuaCSS = { compileLuaCSS };
}

// ─── Example (remove in production) ─────────────────────────────────────────
/*

const src = `
body = {
  background = color.hex("#0f0f13"),
  color      = color.rgb(220, 220, 240),
  font_size  = "1rem",
  opacity    = 1,
}

h1 = {
  font_size   = "2rem",
  color       = color.hsl(262, 83, 74),
  font_weight = 800,

  hover = function()
    opacity = 0.8
    color   = 0xa78bfa
  end,

  before = function()
    content = "→ "
    color   = color.color3(0.2, 0.83, 0.6)
  end,

  span = {
    color = color.rgba(255, 255, 255, 0.5),
  },
}

["\.card"] = {
  background    = color.rgba(255, 255, 255, 0.04),
  border_radius = "12px",
  padding       = "24px",

  hover = function()
    transform = "translateY(-2px)"
  end,

  ["&:nth-child(2)"] = {
    border = "2px solid",
    border_color = color.hex("#a78bfa"),
  },
}
`;

const { css, errors } = compileLuaCSS(src);
console.log(css);
// errors contains any non-fatal parser warnings

*/
