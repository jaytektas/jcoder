# Publishing jcoder in Chrome to the Chrome Web Store

Everything the store asks for, ready to paste. The extension is built from
`extension/`. Every release (`scripts/release.sh`) attaches it as
`jcoder-chrome-X.Y.Z.zip`, with the version set to jcoder's, ready to
upload.

## Once: the developer account

1. Sign in at https://chrome.google.com/webstore/devconsole with the Google
   account that should own the listing, and pay the one-off registration
   fee (US$5).
2. Verify the contact email (Account tab).

## The first upload

1. **Items → New item**, and upload `jcoder-chrome-X.Y.Z.zip` from the
   latest GitHub release.
2. Fill in the tabs below, then **Submit for review**. Review usually takes
   a few days; the `debugger` permission tends to get a closer look.
3. Once it's published:
   - put its URL in `STORE_URL` in `src/browser.ts`, so `/browser` sends
     people to the store instead of to "Load unpacked", and add the link to
     the README's *jcoder in Chrome* section;
   - optionally, under **Package → View public key**, copy the key into
     `extension/manifest.json` as `"key": "…"`. Unpacked copies then get
     the same extension ID as the store's, so a developer who has both
     installed doesn't have two copies connecting to jcoder. The release zip
     drops the key, since the store refuses uploads that have one.

## Each release after that

**Package → Upload new package** with the release's zip, then **Submit
for review**. The version goes up with every jcoder release, as the store
requires. People who installed from the store get it automatically.

---

## Store listing tab

**Name** (from the manifest): jcoder in Chrome

**Summary** (from the manifest, 132 characters at most):
> Lets jcoder, the local coding agent, drive this browser: read pages, click, type, take screenshots, read the console and network.

**Description:**

> jcoder is a coding agent that runs on your own machine, with your own
> model (llama.cpp, LM Studio, Ollama, vLLM or any OpenAI-compatible
> server). This extension lets it use Chrome when you ask it to: test the
> web app it just changed, reproduce a bug, fill in a form, or check what a
> page says.
>
> What jcoder can do with it:
> • Read a page as a list of elements with refs, so even models without
>   vision can act on it; search for elements; read the page's text.
> • Click, double-click, right-click, hover, type, press keys and
>   shortcuts, scroll, drag, choose options, tick boxes, upload files and
>   answer dialogs.
> • Take screenshots and close-ups (for models that can see).
> • Read console messages and errors, network requests and response
>   bodies, and run JavaScript in the page, to debug what it's building.
> • Open, close and switch tabs, go back and forward, resize the window.
>
> It stays out of your way:
> • It works only in its own tab group, one per jcoder session. Drag a tab
>   into the group to hand it over.
> • In jcoder's default mode it asks once per site before it clicks, types
>   or runs anything there. Read-only mode only looks.
> • It talks only to the jcoder you connect it to, on your own computer
>   by default. No servers of its own, no analytics.
>
> To use it, install jcoder (https://github.com/jaytektas/jcoder), run
> `/browser on`, and the extension connects by itself. Running jcoder on
> another machine? Forward its port over ssh, or set the address and a
> token in the extension's popup.
>
> jcoder and this extension are free software (GPL-3.0-or-later).

**Category:** Developer Tools

**Language:** English

**Graphic assets** (all in this folder):

| asset | file | size |
|---|---|---|
| Store icon | `store-icon.png` | 128×128 (96×96 artwork, transparent padding, per the store's guidelines) |
| Screenshot 1 | `screenshot-1.png` | 1280×800 |
| Screenshot 2 | `screenshot-2.png` | 1280×800 |
| Small promo tile | `promo-small.png` | 440×280 |

The screenshots show a real session. The transcript and page are from jcoder
(with a local Qwen model) driving a demo app whose save endpoint fails, and
the model found the cause from the console and network. The layouts are in
`art/`. To change one, edit its HTML and render it again:

```sh
chrome --headless=new --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1280,800 --screenshot=screenshot-1.png "file://$PWD/art/screenshot-1.html"
```

**Official URL / Homepage URL:** https://github.com/jaytektas/jcoder

**Support URL:** https://github.com/jaytektas/jcoder/issues

## Privacy tab

**Single purpose:**
> Lets the jcoder coding agent, which the user runs themselves, operate
> web pages in a dedicated tab group at the user's request: reading pages,
> acting on them, and reading their console and network for debugging.

**Permission justifications:**

- **debugger**: The core of the extension. Through the Chrome DevTools
  Protocol it sends real mouse and keyboard input, takes screenshots,
  reads console messages and network requests, answers page dialogs and
  runs the user's agent's JavaScript in the page. It's attached only to
  tabs in jcoder's own tab group, which the user can see and control, and
  Chrome shows its usual "started debugging this browser" bar.
- **tabs**: To open, close, activate and list the tabs in jcoder's group,
  and to tell jcoder each tab's title and URL.
- **tabGroups**: To create and label the tab group that jcoder is confined
  to, one per jcoder session.
- **storage**: To save the extension's settings (which addresses to
  connect to, and an optional token) and which tab group belongs to which
  jcoder session.
- **alarms**: To wake the service worker every 30 seconds while no jcoder
  is connected, so it connects when the user starts jcoder.

**Host permissions:** none requested.

**Remote code:** Answer *No, I am not using remote code*. All the
extension's own code is in the package. Note in the justification box:

> The extension runs no remote code in its own context. At the request of
> the user's own agent (jcoder, which the user runs and connects), it can
> evaluate JavaScript in the web pages of its tab group through the
> DevTools protocol, as DevTools does. That code runs in the page, not in
> the extension.

*Judgement call:* reviewers sometimes read "executes JavaScript it's sent"
as remote code. If the review comes back on this, the honest answer is the
paragraph above. The fallback is to ship without the `js` action and keep
it in unpacked builds only.

**Data usage**: tick:
- **Website content** (text, images, page content of tabs in jcoder's
  group)
- **User activity** (network requests and console of those tabs; the
  input it sends)

and certify all three statements: data isn't sold to third parties, isn't
used or transferred for purposes unrelated to the single purpose, and
isn't used to determine creditworthiness or for lending.

**Privacy policy URL:**
https://github.com/jaytektas/jcoder/blob/master/docs/chrome-extension-privacy.md
(the policy is `docs/chrome-extension-privacy.md`; it needs to be pushed
before the URL works).

## Distribution tab

Public, all regions. Free.
