import { __asyncValues } from "tslib";
import { DefaultRubyVM } from "./browser.js";
import { RubyVM } from "./vm.js";
/**
 * The main entry point of `<script type="text/ruby">`-based scripting with WebAssembly Core Module.
 */
export const main = async (pkg, options) => {
    const scriptEnv = parseDataEnv(document.currentScript);
    const response = fetch(`https://cdn.jsdelivr.net/npm/${pkg.name}@${pkg.version}/dist/ruby+stdlib.wasm`);
    const module = await compileWebAssemblyModule(response);
    const { vm } = await DefaultRubyVM(module, Object.assign(Object.assign({}, options), { env: Object.assign(Object.assign({}, scriptEnv), options === null || options === void 0 ? void 0 : options.env) }));
    await mainWithRubyVM(vm);
};
/**
 * The main entry point of `<script type="text/ruby">`-based scripting with WebAssembly Component.
 */
export const componentMain = async (pkg, options) => {
    const scriptEnv = parseDataEnv(document.currentScript);
    const componentUrl = `https://cdn.jsdelivr.net/npm/${pkg.name}@${pkg.version}/dist/component`;
    const fetchComponentFile = (relativePath) => fetch(`${componentUrl}/${relativePath}`);
    const { vm } = await RubyVM.instantiateComponent(Object.assign(Object.assign({}, options), { env: Object.assign(Object.assign({}, scriptEnv), options.env), getCoreModule: (relativePath) => {
            const response = fetchComponentFile(relativePath);
            return compileWebAssemblyModule(response);
        } }));
    await mainWithRubyVM(vm);
};
const mainWithRubyVM = async (vm) => {
    vm.printVersion();
    globalThis.rubyVM = vm;
    // Wait for the text/ruby script tag to be read.
    // It may take some time to read ruby+stdlib.wasm
    // and DOMContentLoaded has already been fired.
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => runRubyScriptsInHtml(vm));
    }
    else {
        runRubyScriptsInHtml(vm);
    }
};
const runRubyScriptsInHtml = async (vm) => {
    var _a, e_1, _b, _c;
    const tags = document.querySelectorAll('script[type="text/ruby"]');
    // Get Ruby scripts in parallel.
    const promisingRubyScripts = Array.from(tags).map((tag) => loadScriptAsync(tag));
    try {
        // Run Ruby scripts sequentially.
        for (var _d = true, promisingRubyScripts_1 = __asyncValues(promisingRubyScripts), promisingRubyScripts_1_1; promisingRubyScripts_1_1 = await promisingRubyScripts_1.next(), _a = promisingRubyScripts_1_1.done, !_a; _d = true) {
            _c = promisingRubyScripts_1_1.value;
            _d = false;
            const script = _c;
            if (script) {
                const { scriptContent, evalStyle } = script;
                switch (evalStyle) {
                    case "async":
                        vm.evalAsync(scriptContent);
                        break;
                    case "sync":
                        vm.eval(scriptContent);
                        break;
                }
            }
        }
    }
    catch (e_1_1) { e_1 = { error: e_1_1 }; }
    finally {
        try {
            if (!_d && !_a && (_b = promisingRubyScripts_1.return)) await _b.call(promisingRubyScripts_1);
        }
        finally { if (e_1) throw e_1.error; }
    }
};
const deriveEvalStyle = (tag) => {
    const rawEvalStyle = tag.getAttribute("data-eval") || "sync";
    if (rawEvalStyle !== "async" && rawEvalStyle !== "sync") {
        console.warn(`data-eval attribute of script tag must be "async" or "sync". ${rawEvalStyle} is ignored and "sync" is used instead.`);
        return "sync";
    }
    return rawEvalStyle;
};
/**
 * Parses the data-env attribute as a JSON object string, for example:
 * data-env='{"RUBY_BOX":"1","MSG":"hello world"}'
 *
 * The parsed value must be a non-null object, not an array. Each key must not
 * contain "=" or NUL, and each value must be a string.
 *
 * JSON is used instead of a shell-like KEY=value list so keys and values can
 * contain spaces and values can contain "=" without custom escaping rules.
 */
const parseDataEnv = (tag) => {
    const rawEnv = tag === null || tag === void 0 ? void 0 : tag.getAttribute("data-env");
    if (!rawEnv) {
        return {};
    }
    const trimmedEnv = rawEnv.trim();
    if (!trimmedEnv) {
        return {};
    }
    let parsedEnv;
    try {
        parsedEnv = JSON.parse(trimmedEnv);
    }
    catch (error) {
        console.warn(`data-env must be a JSON object string. ${rawEnv} is ignored.`);
        return {};
    }
    if (typeof parsedEnv !== "object" ||
        parsedEnv === null ||
        Array.isArray(parsedEnv)) {
        console.warn(`data-env must be a JSON object string. ${rawEnv} is ignored.`);
        return {};
    }
    return Object.entries(parsedEnv).reduce((env, [key, value]) => {
        if (key.includes("=") || key.includes("\0")) {
            console.warn(`data-env key must not contain "=" or NUL. ${key} is ignored.`);
            return env;
        }
        // POSIX environment values may contain arbitrary bytes, but data-env only accepts strings.
        if (typeof value !== "string") {
            console.warn(`data-env value for ${key} must be a string. It is ignored.`);
            return env;
        }
        env[key] = value;
        return env;
    }, {});
};
const loadScriptAsync = async (tag) => {
    const evalStyle = deriveEvalStyle(tag);
    // Inline comments can be written with the src attribute of the script tag.
    // The presence of the src attribute is checked before the presence of the inline.
    // see: https://html.spec.whatwg.org/multipage/scripting.html#inline-documentation-for-external-scripts
    if (tag.hasAttribute("src")) {
        const url = tag.getAttribute("src");
        const response = await fetch(url);
        if (response.ok) {
            return { scriptContent: await response.text(), evalStyle };
        }
        return Promise.resolve(null);
    }
    return Promise.resolve({ scriptContent: tag.innerHTML, evalStyle });
};
// WebAssembly.compileStreaming is a relatively new API.
// For example, it is not available in iOS Safari 14,
// so check whether WebAssembly.compileStreaming is available and
// fall back to the existing implementation using WebAssembly.compile if not.
const compileWebAssemblyModule = async function (response) {
    if (!WebAssembly.compileStreaming) {
        const buffer = await (await response).arrayBuffer();
        return WebAssembly.compile(buffer);
    }
    else {
        return WebAssembly.compileStreaming(response);
    }
};
