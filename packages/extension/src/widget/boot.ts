// widget.html's only eager script (security review item 5): widget.html is a web-accessible resource, so any page can
// frame it. Without a well-formed token fragment, or when it is not framed, it stops here and never loads the app bundle
// (React, the step controls, the client): a page probing for the extension learns nothing more than that the file
// exists. The app itself is a lazy chunk; its widget.hello then checks the token for real (single-use, per frame).
const TOKEN = /(?:^#|&)token=([A-Za-z0-9-]{16,128})(?:&|$)/;

export function shouldBoot(hash: string, framed: boolean): boolean {
  return framed && TOKEN.test(hash);
}

let framed = false;
try {
  framed = window.top !== window;
} catch {
  framed = true; // a cross-origin top that throws on access is still a parent
}
if (shouldBoot(location.hash, framed)) void import('./main');
