// host-fixture.mjs — test support: the one place a host-* test builds a hosts.json entry. Not a test file (no `.test.mjs`, and no `test-` prefix), so `node --test` does not run it.
// The entry goes through `validateHosts` as `loadHosts` would, so it carries the registry defaults (`coHome`) and a new required field is added here once.
import { validateHosts } from './hosts.mjs';

/** A validated hosts.json entry for ssh alias `ssh` with home `home`, its repos in `<home>/D` and ship-dag in `<home>/D/ship-dag`; `extra` overrides or adds fields, such as an `sdHome` outside `reposDir` for a test that must tell the two apart. */
export const testHost = (home = '/h', extra = {}, ssh = 'box') =>
  validateHosts({ [ssh]: { ssh, home, reposDir: `${home}/D`, sdHome: `${home}/D/ship-dag`, ...extra } })[ssh];
