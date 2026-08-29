export async function resolveInsecureBase(approvalKeyboardOnly, discoverInsecureBase) {
  return approvalKeyboardOnly ? null : await discoverInsecureBase();
}
