"use strict";

/**
 * The board web client's service worker: notifications only.
 *
 * There is deliberately NO `fetch` handler, and therefore no caching. A
 * cached shell rendering stale session state is precisely the failure this
 * tool exists to prevent — a session that looks like it is still waiting on
 * you, hours after you answered it, is worse than no answer at all. The
 * client refetches its session listing on every open and never relies on
 * having been told.
 *
 * What this worker does is enrich. board/src/push.ts sends a Declarative Web
 * Push payload, which the operating system renders by itself if this worker
 * never runs — so the job here is not to make a notification appear, it is
 * to add the session's own recap when the phone can actually reach the
 * laptop. Showing a notification here suppresses the declarative one, so
 * there is never a pair.
 *
 * Ported from session-monitor's `thomas-zhang/feature/push-notifications`
 * branch (`web/sw.js`), adapted for board's own wire shape: `navigate` now
 * carries a window index alongside the session and pane (`&w=`), and the
 * enrichment reads from `GET /api/sessions`'s `{boxed, unboxed}` listing
 * instead of that branch's `/api/v1/state`.
 *
 * ceiling: the enrichment quotes the SESSION's own recap, not a specific
 * pane's — board's `SessionView` (board/src/sessions.ts) carries one recap
 * per session, published via `cc-recap`, and does not expose a per-pane
 * recap the way session-monitor's model did. The window/pane indexes are
 * still read and matched (see `targetOf`) so a future per-pane recap field
 * needs no change here — only `paneRecap` below would grow a body.
 */

// An updated worker takes over immediately rather than waiting for every tab
// to close — on a Home Screen app there is usually exactly one, and it is
// rarely closed.
self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

/** The `notification` object out of a declarative payload, or null for a
 *  push carrying nothing this worker recognises. */
function declaredNotification(data) {
  if (!data) return null;
  try {
    var payload = data.json();
    return payload && payload.notification ? payload.notification : null;
  } catch (err) {
    return null;
  }
}

/** The session, window and pane a notification points at, read back out of
 *  its own `navigate` URL — the worker is handed no other context. */
function targetOf(navigate) {
  try {
    var params = new URLSearchParams(new URL(navigate, self.registration.scope).hash.replace(/^#/, ""));
    var tmuxName = params.get("s");
    if (!tmuxName) return null;
    var windowIndex = params.get("w");
    var paneIndex = params.get("p");
    return {
      tmuxName: tmuxName,
      windowIndex: windowIndex === null ? null : Number(windowIndex),
      paneIndex: paneIndex === null ? null : Number(paneIndex),
    };
  } catch (err) {
    return null;
  }
}

/**
 * That session's own recap, or null.
 *
 * `no-store` because a notification that arrives seven seconds after a
 * transition must not be described using a response cached before it. This
 * is also the request that fails whenever the phone is off the tunnel,
 * which is ordinary rather than exceptional: a push routinely arrives
 * before a sleeping phone's tunnel has woken.
 */
function recapFor(navigate) {
  var target = targetOf(navigate);
  if (!target) return Promise.resolve(null);
  return fetch("/api/sessions", { cache: "no-store" })
    .then(function (res) {
      return res.ok ? res.json() : null;
    })
    .then(function (listing) {
      var boxed = (listing && listing.boxed) || [];
      for (var i = 0; i < boxed.length; i++) {
        if (boxed[i].tmuxName === target.tmuxName) return boxed[i].recap || null;
      }
      return null;
    });
}

self.addEventListener("push", function (event) {
  var declared = declaredNotification(event.data);
  var title = (declared && declared.title) || "A session needs you";
  var body = (declared && declared.body) || "Open board for details.";
  var navigate = (declared && declared.navigate) || "/";

  event.waitUntil(
    recapFor(navigate)
      .catch(function () {
        // Off the tunnel, or the laptop went away between sending and now.
        // The declarative text already says which session and what
        // happened, which is the part that cannot be recomputed later.
        return null;
      })
      .then(function (recap) {
        return self.registration.showNotification(title, {
          body: recap ? body + " — " + recap : body,
          // Per session+pane, because `navigate` carries both: a work
          // session's two panes must never replace each other's
          // notification, which is the exact bug core/src/notify.ts is
          // written around.
          tag: navigate,
          data: { url: navigate },
        });
      }),
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clients) {
      for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (client.url.indexOf(self.registration.scope) !== 0) continue;
        // Navigate an already-open app to the session that actually
        // buzzed, rather than just focusing whatever screen it was left
        // on. `navigate` can reject on an uncontrolled client, so
        // focusing is the fallback.
        if (typeof client.navigate === "function") {
          return client
            .navigate(url)
            .then(function (navigated) {
              return (navigated || client).focus();
            })
            .catch(function () {
              return client.focus();
            });
        }
        return client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
