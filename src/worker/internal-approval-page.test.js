import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { handleInternalAuth } from "./internal-auth";

async function page(reply, query = "") {
  const url = `https://beta.ai-outfitter.com/internal/authorize${query}`;
  const response = await handleInternalAuth(new Request(url), { INTERNAL_INFERENCE_ENABLED: "true" });
  const fetch = vi.fn().mockResolvedValueOnce(reply);
  const dom = new JSDOM(await response.text(), { url, runScripts: "dangerously", beforeParse(window) { window.fetch = fetch; } });
  await vi.waitFor(() => expect(dom.window.document.querySelector('#status').textContent).not.toBe('Checking sign-in…'));
  return { dom, fetch, document: dom.window.document };
}

describe('CLI browser approval', () => {
  it('shows the authenticated identity and enables explicit approval after the callback', async () => {
    const {dom,document,fetch} = await page(Response.json({user:{login:'alice'}}), '?user_code=ABC123');
    expect((document.querySelector('#signin')).hidden).toBe(true);
    expect(document.querySelector('#status').textContent).toContain('Signed in as alice');
    fetch.mockResolvedValueOnce(Response.json({ok:true}));
    (document.querySelector('button[value="approve"]')).click();
    await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({user_code:'ABC123',action:'approve'});
    dom.window.close();
  });
  it('preserves a typed code and prevents duplicate sign-in requests', async () => {
    const {dom,document,fetch} = await page(Response.json({error:'unauthorized'},{status:401}));
    (document.querySelector('input')).value='ABC123';
    fetch.mockImplementationOnce(()=>new Promise(()=>{}));
    const button=document.querySelector('#signin');
    button.click();button.click();
    expect(fetch).toHaveBeenCalledTimes(2);
    const body=JSON.parse(fetch.mock.calls[1][1].body);
    expect(body.callbackURL).toBe('https://beta.ai-outfitter.com/internal/authorize?user_code=ABC123');
    expect(body.errorCallbackURL).toBe(body.callbackURL);
    expect(button.disabled).toBe(true);
    dom.window.close();
  });
  it('explains failed OAuth and blocks approval while signed out', async () => {
    const {dom,document} = await page(Response.json({error:'unauthorized'},{status:401}), '?error=state_mismatch');
    expect(document.querySelector('#status').textContent).toContain('Start again here in this tab');
    expect((document.querySelector('button[value="approve"]')).disabled).toBe(true);
    dom.window.close();
  });
});
