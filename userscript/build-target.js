/**
 * The browser baseline the bundle is compiled down to.
 *
 * The script is installed through a userscript manager in whichever browser
 * the reader uses, so the baseline is the intersection of both supported
 * engines rather than either one alone. Firefox 115 is the ESR; Chrome 115 is
 * its contemporary.
 *
 * build.mjs and tests/main.test.js both compile main.js, and must agree on
 * this -- otherwise the bundle under test is not the bundle that ships.
 */
export const BUILD_TARGET = ["firefox115", "chrome115"];
