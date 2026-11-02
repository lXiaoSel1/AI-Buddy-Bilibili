// A small stand-in for React and the page globals, for rendering the plugin pages in tests. The page component keeps
// its hook state across renders, setState re-renders on a microtask, effects run after a render when their deps
// change, and child function components (Seg, Switch, Dialog) are expanded with throwaway hooks. fetch is answered
// by the test's route handler, shaped like the plugin's native route ({error:{code,message}} with a 403).
const GENERIC = '操作未完成，请查看插件状态。';
export const ok = body => ({status: 200, body});
export const refuse = code => ({status: 403, body: {error: {code, message: GENERIC}}});

export function mountPage(t, createPage, route, {lang = 'zh-CN', embedded = false} = {}) {
  const saved = {window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch};
  const events = new EventTarget(), dataset = {buddyLang: lang === 'en' ? 'en' : 'zh-CN', ...(embedded ? {buddyEmbedded: ''} : {})}, styles = [], calls = [];
  globalThis.window = {location: {href: 'https://local.invalid/page'}, addEventListener: (type, fn) => events.addEventListener(type, fn), removeEventListener: (type, fn) => events.removeEventListener(type, fn), dispatchEvent: event => events.dispatchEvent(event)};
  globalThis.document = {documentElement: {dataset}, activeElement: null, getElementById: () => null, createElement: tag => ({tag}), head: {append: el => styles.push(el)}, addEventListener() {}, removeEventListener() {}};
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null, action = body?.action ?? new URL(String(url), 'https://local.invalid').searchParams.get('action');
    calls.push({action, payload: body?.payload ?? null});
    const answer = await route(action, body?.payload ?? {});
    return {ok: answer.status < 400, status: answer.status, json: async () => structuredClone(answer.body)};
  };
  const slots = [], queue = [];let cursor = 0, child = false, pending = false, alive = true, tree = null;
  const schedule = () => {if (pending || !alive) return;pending = true;queueMicrotask(() => {pending = false;render();});};
  const React = {Fragment: 'fragment',
    createElement: (type, props, ...children) => ({type, props: {...(props ?? {}), ...(children.length ? {children: children.length === 1 ? children[0] : children} : {})}, children}),
    useState(init) {
      if (child) return [typeof init === 'function' ? init() : init, () => {}];
      const i = cursor++, slot = slots[i] ??= {value: typeof init === 'function' ? init() : init};
      return [slot.value, next => {const value = typeof next === 'function' ? next(slot.value) : next;if (Object.is(value, slot.value)) return;slot.value = value;schedule();}];
    },
    useRef(init) {if (child) return {current: init};const i = cursor++;return slots[i] ??= {current: init};},
    useEffect(effect, deps) {
      if (child) return;
      const i = cursor++, slot = slots[i] ??= {fresh: true};
      if (slot.fresh || !deps || deps.length !== slot.deps.length || deps.some((d, k) => !Object.is(d, slot.deps[k]))) {slot.fresh = false;slot.deps = deps;queue.push(() => {slot.cleanup?.();const out = effect();slot.cleanup = typeof out === 'function' ? out : null;});}
    }};
  const expand = node => {
    if (node == null || node === false || node === true) return [];
    if (Array.isArray(node)) return node.flatMap(expand);
    if (typeof node !== 'object') return [String(node)];
    if (typeof node.type === 'function') {child = true;let out;try {out = node.type(node.props);} finally {child = false;}return expand(out);}
    return [{type: node.type, props: node.props, children: node.children.flatMap(expand)}];
  };
  const Page = createPage(React);
  function render() {if (!alive) return;cursor = 0;tree = expand(Page({}))[0];for (const run of queue.splice(0)) run();}
  render();
  const unmount = () => {if (!alive) return;alive = false;for (const slot of slots) slot?.cleanup?.();Object.assign(globalThis, saved);for (const [key, value] of Object.entries(saved)) if (value === undefined) delete globalThis[key];};
  t.after(unmount);
  const text = (node = tree) => node == null ? '' : typeof node === 'string' ? node : node.children.map(text).join('');
  const all = (test, node = tree, out = []) => {if (node && typeof node === 'object') {if (test(node)) out.push(node);for (const c of node.children) all(test, c, out);}return out;};
  const button = label => all(n => n.type === 'button' && (text(n).includes(label) || n.props['aria-label'] === label))[0];
  return {
    calls, styles, dataset, events, unmount,
    get tree() {return tree;}, text: () => text(),
    all, textOf: text, button,
    async settle() {for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve));},
    async click(label) {const b = typeof label === 'string' ? button(label) : label;if (!b) throw Error('No button: ' + label);if (b.props.disabled) throw Error('Disabled button: ' + label);b.props.onClick?.({preventDefault() {}, target: {closest: () => null}, currentTarget: {}});await this.settle();},
    async change(ariaLabel, value) {const el = all(n => n.props['aria-label'] === ariaLabel && n.props.onChange)[0];if (!el) throw Error('No field: ' + ariaLabel);el.props.onChange({target: {value, checked: value}});await this.settle();},
    async dispatch(type, detail) {window.dispatchEvent(new CustomEvent(type, {detail}));await this.settle();},
    count: action => calls.filter(call => call.action === action).length,
  };
}
