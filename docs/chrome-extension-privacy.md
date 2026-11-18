# jcoder in Chrome: privacy policy

*Last updated 18 November 2026*

jcoder in Chrome is a browser extension that lets jcoder, a coding agent
you run yourself, use web pages in Chrome when you ask it to. This policy
covers what the extension reads, where that goes, and what it keeps.

## The short version

The extension sends what it reads only to the jcoder program you connect
it to: by default, jcoder on your own computer. It has no servers of its
own, no analytics and no tracking. Nothing is sent to the developer.

## What it reads

Only from the tabs in jcoder's own tab group (tabs jcoder opened, or tabs
you dragged into the group), and only when jcoder asks:

- the page's address, title and content: its text and form fields,
  including what you have typed into them (password fields are listed as
  `••••`, not their contents);
- screenshots of the visible part of the page;
- the page's console messages and network requests, including response
  bodies when jcoder asks for one;
- the results of JavaScript that jcoder asks to run in the page. Such
  code can read whatever that page's own scripts can, including its form
  fields and its cookies that aren't HttpOnly.

It doesn't read tabs outside that group, and it doesn't read your
browsing history, bookmarks or saved passwords.

## Where it goes

To the jcoder you connected it to, over a WebSocket. By default that's
`127.0.0.1` (your own computer, ports 47823 to 47832). If you change the
address in the extension's settings, it goes to that address instead.

jcoder passes what it needs to the language model you set it up with.
That is often a model running on your own machine, but it can be a
remote service you chose. What happens to the data there is governed by
jcoder's settings and that service's policy, not by this extension.

## What it keeps

- **Settings** (the addresses to connect to, and a token if you set one),
  in Chrome's extension storage on your computer.
- **Which tab group belongs to which jcoder session**, in session storage,
  cleared when Chrome closes.
- **Recent console messages and network requests** of jcoder's tabs, in
  memory, so jcoder can ask for them. They're gone when the tab closes or
  the extension restarts.

Nothing is written anywhere else.

## Your control

- jcoder works only in its own tab group; you decide which tabs are in it.
- Chrome shows that jcoder is debugging the browser while it works;
  cancelling that bar stops it until its next action.
- In jcoder's default mode it asks you once per site before clicking,
  typing or running anything there; read-only mode only looks.
- Removing the extension removes its settings.

## Not sold, not shared

Data the extension handles is never sold, never transferred for purposes
other than letting jcoder do what you asked, and never used to decide
creditworthiness or for lending.

## Contact

Questions or problems: open an issue at
https://github.com/jaytektas/jcoder/issues.
