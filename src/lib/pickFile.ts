/**
 * Picking files in the browser.
 *
 * The desktop reaches for a native dialog and gets back absolute paths; a
 * browser has no paths to give, only the files themselves, and the only way to
 * ask for one is an `<input type="file">` the page builds, clicks and drops.
 *
 * One implementation, because every caller wants the same thing from it: ask,
 * wait, hand the answer on. What differs is only the filter.
 */

/** The files the reader picked, or an empty list if they changed their mind. */
export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = multiple;
    input.accept = accept;
    // A cancelled dialog fires `cancel` in current browsers; an old one fires
    // nothing at all, in which case the element is simply left to be collected
    // — the promise it belongs to is the leak that would matter, and it does
    // not exist: a reader who cancels and tries again gets a fresh picker.
    const done = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => done([...(input.files ?? [])]));
    input.addEventListener("cancel", () => done([]));
    input.style.display = "none";
    document.body.append(input);
    input.click();
  });
}

/** Extensions into the `accept` string an `<input type="file">` wants. */
export const acceptOf = (extensions: readonly string[]): string =>
  extensions.map((extension) => `.${extension}`).join(",");
