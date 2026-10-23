/** Download a Library file to check its bytes: HTTPS only, no credentials, no redirects, 8 MiB. */
export async function readLibraryContent(url: string): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    throw Error("invalid_content_url");
  const response = await fetch(parsed, {
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error("artifact_verification_unavailable");
  const reader = response.body!.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > 8 * 1024 * 1024) {
      await reader.cancel();
      throw Error("artifact_too_large");
    }
    parts.push(part.value);
  }
  return Buffer.concat(parts);
}
