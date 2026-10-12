// A module.register() resolve hook for script tests that load agent modules.
// They run under plain `node --experimental-strip-types`, not tsx. Agent code
// imports a sibling as `./name.js`, which tsx and hosting resolve to
// `name.ts` and plain Node does not, so a relative `.js` import from a `.ts`
// module that is not found is retried as `.ts`. Register it before the first
// dynamic import of an agent module that imports a sibling:
//
//   register("./ts-resolve.mjs", import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    if (error?.code !== "ERR_MODULE_NOT_FOUND" || !relative || !specifier.endsWith(".js") || !context.parentURL?.endsWith(".ts")) throw error;
    return nextResolve(`${specifier.slice(0, -".js".length)}.ts`, context);
  }
}
