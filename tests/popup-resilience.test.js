"use strict";

const ui = require("../chatgpt-ui");
const { chromium } = require("playwright");

const COMP =
    '<textarea id="composer" aria-label="Chat with ChatGPT" placeholder="Ask ChatGPT" style="width:400px;height:60px"></textarea>';

function modal(attrs, inner) {
    return `<div ${attrs} role="dialog" aria-modal="true" style="position:fixed;inset:5%;background:#fff;border:1px solid #333">${inner}</div>`;
}

function closeBtn(opts = {}) {
    const cls = [
        opts.focus && "is-focused focus-visible",
        opts.hover && "is-hovered",
        opts.active && "active pressed",
        opts.iconOnly && "icon",
    ]
        .filter(Boolean)
        .join(" ");
    const rm = "document.getElementById('auth')&&document.getElementById('auth').remove()";
    if (opts.iconOnly) return `<button class="xbtn ${cls}" onclick="${rm}"><svg width="12" height="12"><circle r="6"/></svg></button>`;
    if (opts.ariaLabelledby)
        return `<button class="xbtn ${cls}" aria-labelledby="cl" onclick="${rm}"><span id="cl">Close</span></button>`;
    return `<button id="cb" class="xbtn ${cls}" aria-label="Close" onclick="${rm}"><svg width="12" height="12"><circle r="6"/></svg></button>`;
}

(async () => {
    const failures = [];
    let total = 0;
    const check = (name, cond) => {
        total++;
        if (!cond) failures.push(name);
        console.log((cond ? "PASS " : "FAIL ") + name);
    };

    const b = await chromium.launch({ headless: true });
    const page = await b.newPage();

    const setup = async (html) => page.setContent(`<div id="app">${COMP}${html}</div>`);

    try {
        // 1. normal popup dismissed via aria-label close button
        await setup(modal('id="auth" data-testid="modal-no-auth-login"', `<h2>Sign in to ChatGPT</h2>${closeBtn()}`));
        let st = await ui.inspectPopup(page);
        check("normal: hasAuthPopup", st.hasAuthPopup);
        let found = await ui.findDismissControl(page);
        check("normal: dismiss control found", !!found);
        await found.button.click();
        await page.waitForTimeout(50);
        check("normal: gone after click", !(await ui.hasAuthPopup(page)));

        // 2. close button that is simultaneously focused + hovered + active
        await setup(modal('id="auth" data-testid="modal-no-auth-login"', `<h2>Sign in</h2>${closeBtn({ focus: true, hover: true, active: true })}`));
        check("focus-hover-active: hasAuthPopup", (await ui.inspectPopup(page)).hasAuthPopup);
        check("focus-hover-active: dismiss found", !!await ui.findDismissControl(page));

        // 3. close button nested deeper in wrapper divs
        await setup(modal('id="auth"', `<h2>Sign in</h2><div class="w1"><div class="w2"><div class="w3">${closeBtn()}</div></div></div>`));
        check("deep-wrapper: dismiss found", !!await ui.findDismissControl(page));

        // 4. icon-only close button (no aria-label, just an svg)
        await setup(modal('id="auth"', `<h2>Sign in</h2>${closeBtn({ iconOnly: true })}`));
        found = await ui.findDismissControl(page);
        check("icon-only: dismiss found via icon heuristic", !!found);

        // 5. close button labelled via aria-labelledby
        await setup(modal('id="auth"', `<h2>Sign in</h2>${closeBtn({ ariaLabelledby: true })}`));
        found = await ui.findDismissControl(page);
        check("aria-labelledby: dismiss found", !!found);

        // 6. popup whose data-testid is NOT the historic "modal-no-auth-login" but has auth text
        await setup(modal('id="auth" data-testid="some-modal-xyz"', `<h2>Stay logged out?</h2>${closeBtn()}`));
        check("alt-testid: hasAuthPopup classified by text", (await ui.inspectPopup(page)).hasAuthPopup);

        // 7. logged-out page without any popup -> composer ready, no false block
        await setup("");
        st = await ui.inspectPopup(page);
        check("no-popup: !hasAuthPopup", !st.hasAuthPopup);
        check("no-popup: composerUsable", st.composerUsable);
        check("no-popup: isPromptReady", await ui.isPromptReady(page));

        // 8. popup that materialises after initial load
        await setup("");
        await page.evaluate(() => {
            window.setTimeout(() => {
                const d = document.createElement("div");
                d.id = "auth";
                d.setAttribute("data-testid", "modal-no-auth-login");
                d.setAttribute("role", "dialog");
                d.setAttribute("aria-modal", "true");
                d.style.cssText = "position:fixed;inset:5%;background:#fff;border:1px solid #333";
                d.innerHTML = `<h2>Sign in</h2><button id="cb" aria-label="Close" onclick="document.getElementById('auth')&&document.getElementById('auth').remove()"><svg></svg></button>`;
                document.body.appendChild(d);
            }, 300);
        });
        await page.waitForFunction(() => document.querySelector("#auth"), { timeout: 3000 });
        check("after-load: hasAuthPopup detected", (await ui.inspectPopup(page)).hasAuthPopup);

        // 9. false-positive guard: a settings modal must NOT be treated as an auth popup
        await setup(
            modal('id="auth" data-testid="modal-no-auth-login"', `<h2>Sign in</h2>${closeBtn()}`) +
                modal('data-testid="modal-settings"', `<h2>Settings</h2><button aria-label="Close">X</button><div>Preferences</div>`)
        );
        st = await ui.inspectPopup(page);
        check("two-modals: both visible (modalCount>=2)", st.modalCount >= 2);
        const dlg = await ui.locateAuthDialog(page);
        check("two-modals: locateAuthDialog targets auth, not settings", (await dlg.evaluate((e) => e.getAttribute("id"))) === "auth");
        check("two-modals: dismiss control scoped to auth modal", !!await ui.findDismissControl(page));

        // 10. upload overlay ("Add anything") must NOT be mistaken for an auth popup
        await page.setContent(
            `<div id="app">${COMP}<div class="upload-banner" style="position:fixed;inset:0"><span>Add anything to ChatGPT</span></div></div>`
        );
        st = await ui.inspectPopup(page);
        check("upload-overlay: !hasAuthPopup", !st.hasAuthPopup);
        check("upload-overlay: detected as overlay", await ui.isUploadOverlay(page));

        // 11. dismissBlockingUI full flow (click removes modal)
        await setup(modal('id="auth" data-testid="modal-no-auth-login"', `<h2>Sign in</h2>${closeBtn()}`));
        check("dismissBlockingUI: cleared", await ui.dismissBlockingUI(page) === true);
        check("dismissBlockingUI: gone after", !(await ui.hasAuthPopup(page)));

        // 12. Escape fallback when the popup has no dismiss control
        await page.setContent(
            `<div id="app">${COMP}<script>document.body.addEventListener('keydown',e=>{if(e.key==='Escape'){const a=document.getElementById('auth2');if(a)a.remove();}})</script><div id="auth2" role="dialog" aria-modal="true" style="position:fixed;inset:5%;background:#fff"><h2>Stay logged out?</h2></div></div>`
        );
        const r = await ui.dismissAuthPopup(page);
        check("escape-fallback: dismissed via Escape", r.dismissed === true && r.method === "escape");

        // 13. popup with no dismiss control and no Escape handler -> reported as not dismissed, no throw
        await page.setContent(
            `<div id="app">${COMP}<div id="auth3" role="dialog" aria-modal="true" style="position:fixed;inset:5%;background:#fff"><h2>Sign in</h2><p>No close button here.</p></div></div>`
        );
        const r2 = await ui.dismissAuthPopup(page);
        check("no-dismiss-no-escape: fails gracefully", r2.dismissed === false);

        // 14. safe click: dismiss control covered by overlay -> click fails -> Escape recovers
        await page.setContent(
            `<div id="app">${COMP}<div id="cover" style="position:fixed;inset:0;background:rgba(0,0,0,.9)"></div><div id="auth4" role="dialog" aria-modal="true" style="position:fixed;inset:5%;background:#fff"><h2>Sign in</h2><button id="cb4" aria-label="Close" onclick="document.getElementById('auth4').remove()">x</button></div><script>document.body.addEventListener('keydown',e=>{if(e.key==='Escape')document.getElementById('cover').remove();})</script></div>`
        );
        const r3 = await ui.dismissAuthPopup(page);
        check("obscured-control: recovers (escape clears cover, click then succeeds)", r3.dismissed === true);

        // 15. Background popup safety monitor: dismisses a popup that appears AFTER the composer is ready
        await page.setContent(`<div id="app">${COMP}</div>`);
        const monitor = ui.startPopupMonitor(page, { intervalMs: 1000 });
        await page.waitForTimeout(1200);
        check("monitor: ran initial no-op tick", monitor.tickCount() >= 1);
        check("monitor: no popup initially", !(await ui.hasAuthPopup(page)));
        check("monitor: composer ready initially", await ui.isPromptReady(page));

        await page.evaluate(() => {
            const d = document.createElement("div");
            d.id = "auth";
            d.setAttribute("data-testid", "modal-no-auth-login");
            d.setAttribute("role", "dialog");
            d.setAttribute("aria-modal", "true");
            d.style.cssText = "position:fixed;inset:5%;background:#fff;border:1px solid #333";
            d.innerHTML = `<h2>Sign in to ChatGPT</h2><button id="cb" aria-label="Close" onclick="document.getElementById('auth')&&document.getElementById('auth').remove()"><svg width="12" height="12"><circle r="6"/></svg></button>`;
            document.body.appendChild(d);
        });

        check("monitor: popup present after injection", (await ui.inspectPopup(page)).hasAuthPopup);

        const dismissed = await page
            .waitForFunction(() => !document.querySelector("#auth"), { timeout: 5000 })
            .then(() => true)
            .catch(() => false);
        check("monitor: late popup dismissed by background monitor", dismissed);
        check("monitor: no auth popup after dismissal", !(await ui.hasAuthPopup(page)));
        check("monitor: composer ready after dismissal", await ui.isPromptReady(page));

        await page.waitForTimeout(800);
        check("monitor: tickCount increased after dismissal", monitor.tickCount() > 1);

        monitor.stop();
    } finally {
        await b.close();
    }

    console.log(`\n${total - failures.length}/${total} passed`);
    if (failures.length) {
        console.log("FAILURES: " + failures.join(", "));
        process.exit(1);
    }
    console.log("ALL TESTS PASSED");
})().catch((e) => {
    console.error("ERR", e.message);
    process.exit(1);
});
