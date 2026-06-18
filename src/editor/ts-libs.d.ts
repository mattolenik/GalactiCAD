/** Virtual module provided by build/ts-libs-plugin.mts: bundled TypeScript
 *  `lib.*.d.ts` sources keyed as "/lib.xxx.d.ts" for the @typescript/vfs fsMap. */
declare module "ts-libs" {
    const libs: Record<string, string>
    export default libs
}
