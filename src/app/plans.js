// Pricing cards. Rendered into index.html at build time (visible before any script runs, no layout shift) and reused by the app.
const n = (x) => x.toLocaleString("en-US");
export const plansHTML = (C) =>
  `<div class="plan"><b>Free</b><div class="price">$0</div><div class="cr">${C.starterCredits} AI credits to start</div><p>Unlimited fixing: existing metadata, Takeout and XMP sidecars, file names, bulk edits, maps, templates, audit log.</p><button type="button" id="plan-free">Start now</button></div>` +
  C.packs.map((p) => `<div class="plan${p.featured ? " featured" : ""}"><b>${n(p.credits)} credits</b><div class="price">${p.price}</div><div class="cr">${p.note}</div><p>AI date and place suggestions for ${n(p.credits)} photos or videos.</p><button type="button" class="${p.featured ? "pri" : ""}" data-buy="${p.id}">Buy</button></div>`).join("");
