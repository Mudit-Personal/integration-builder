// The browser only runs sandboxed, where assertPublicUrl is never reached. check() answers true so a stray call fails closed.
export const isIP = () => 0;
export class BlockList {
  addSubnet() {}
  check() { return true; }
}
