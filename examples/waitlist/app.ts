// A tiny stand-in app for trying visitor mode: a landing page, a signup
// form, and an endpoint that counts signups. Nothing is stored.
//
//   node examples/waitlist/app.ts          # http://127.0.0.1:4180
//   sdd simulate --workdir examples/waitlist --target http://127.0.0.1:4180 \
//     --run demo --runs 2 --budget-usd 1

import { createServer } from 'node:http';

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:17px/1.5 system-ui,sans-serif;margin:0;background:#f4efe6;color:#1d1b18}main{max-width:640px;margin:0 auto;padding:28px 20px}
h1{font-size:2.1rem;line-height:1.1;margin:.2em 0}h2{font-size:1.3rem;margin-top:1.6em}.cta,button{display:inline-block;background:#d2452d;color:#fff;border:0;padding:14px 22px;font:inherit;font-weight:700;text-decoration:none}
label{display:block;margin-top:14px;font-weight:600}input{display:block;width:100%;box-sizing:border-box;padding:12px;font:inherit;border:2px solid #1d1b18}small{color:#6a655c}</style></head><body><main>${body}</main></body></html>`;

let signups = 0;
createServer((req, res) => {
  const send = (html: string) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  if (req.method === 'POST' && req.url === '/api/waitlist') {
    req.resume();
    req.on('end', () => {
      signups++;
      console.log(`signup ${signups}`);
      res.writeHead(303, { location: '/thanks' }).end();
    });
  } else if (req.url === '/join') {
    send(page('Join the list', `<h1>Get on the list</h1><p>One email when kits are ready to order. Nothing else.</p>
      <form method="post" action="/api/waitlist"><label for="name">First name</label><input id="name" name="name" autocomplete="off">
      <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="off">
      <p><button type="submit">Put me on the list</button></p></form><small>No payment now. Price is not set yet.</small>`));
  } else if (req.url === '/thanks') {
    send(page('You are on the list', '<h1>You are on the list.</h1><p>We will email you once, when kits are ready.</p>'));
  } else {
    send(page('Benchbot: a robot sidekick for your workshop', `<p><small>A desktop robot kit</small></p>
      <h1>The robot sidekick you wanted as a kid. For your workbench.</h1>
      <p>Benchbot is a small robot that sits on your bench, watches what you are working on, and talks it through with you. It can hold a part, point a light, and look things up while your hands are busy.</p>
      <p><a class="cta" href="/join">Tell me when I can get one</a></p>
      <h2>What it is</h2><p>A kit you build in a weekend: a body about the size of a coffee can, two arms, a camera, and a speaker. It runs an AI model that sees and hears the bench.</p>
      <h2>What it is not</h2><p>It does not walk, and it will not do your project for you. It is a helper and a second pair of eyes.</p>
      <h2>Where it stands</h2><p>Working prototypes exist. Kits are not for sale yet, and the price is not set. The list is how we will tell you.</p>
      <p><a class="cta" href="/join">Tell me when I can get one</a></p>`));
  }
}).listen(Number(process.env.PORT ?? 4180), process.env.HOST ?? '127.0.0.1', () => console.log(`Waitlist example app on port ${process.env.PORT ?? 4180}`));
