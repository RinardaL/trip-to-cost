/* Trip cost calculator: reads window.COST_DATA (js/cost-data.js) and updates the pre-rendered result.
   Every figure is per person in USD from the itinerary cost ladders, flights excluded. */
(function () {
  "use strict";
  var DATA = window.COST_DATA;
  var form = document.getElementById("calcForm");
  if (!DATA || !form) return;

  var byId = {};
  DATA.forEach(function (r) { byId[r[0]] = { id: r[0], place: r[1], country: r[2], n: r[3], ladder: r[4] }; });

  var els = {
    trip: document.getElementById("calcTrip"),
    days: document.getElementById("calcDays"),
    trav: document.getElementById("calcTravellers"),
    from: document.getElementById("calcFrom"),
    place: document.getElementById("rPlace"),
    rDays: document.getElementById("rDays"),
    rTrav: document.getElementById("rTravellers"),
    total: document.getElementById("rTotal"),
    range: document.getElementById("rRange"),
    perPerson: document.getElementById("rPerPerson"),
    perDay: document.getElementById("rPerDay"),
    budget: document.getElementById("rBudget"),
    middle: document.getElementById("rMiddle"),
    comfortable: document.getElementById("rComfortable"),
    note: document.getElementById("rNote"),
    flights: document.getElementById("rFlights"),
    link: document.getElementById("rLink"),
    breakdown: document.querySelector(".calc-breakdown")
  };

  function round5(x) { return Math.round(x / 5) * 5; }
  function mid(lo, hi) { return round5((lo + hi) / 2); }
  function code() { return typeof getCurrency === "function" ? getCurrency() : "USD"; }
  function money(usd) {
    var c = code();
    if (c === "USD" || typeof CURRENCIES === "undefined" || typeof convertUsd !== "function") return "$" + usd.toLocaleString("en-US");
    return CURRENCIES[c].symbol + convertUsd(usd, c).toLocaleString("en-US");
  }
  function style() {
    var r = form.querySelector('input[name="calcStyle"]:checked');
    return r ? r.value : "middle";
  }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

  function fillDays(trip, keep) {
    var want = keep && keep <= trip.n ? keep : trip.n;
    var html = "";
    for (var i = 1; i <= trip.n; i++) html += '<option value="' + i + '"' + (i === want ? " selected" : "") + ">" + plural(i, "day", "days") + "</option>";
    els.days.innerHTML = html;
  }

  function city(place) { return place.split(",")[0].replace(/\s*&.*$/, "").trim(); }

  function render() {
    var trip = byId[els.trip.value] || byId.lisbon;
    var days = Math.min(parseInt(els.days.value, 10) || trip.n, trip.n);
    var travellers = Math.max(1, Math.min(8, parseInt(els.trav.value, 10) || 1));
    var pair = trip.ladder[days - 1];
    var lo = pair[0], hi = pair[1], m = mid(lo, hi);
    var chosen = { budget: lo, middle: m, comfortable: hi }[style()];

    els.place.textContent = trip.place;
    els.rDays.textContent = plural(days, "day", "days");
    els.rTrav.textContent = plural(travellers, "traveller", "travellers");
    els.total.textContent = money(chosen * travellers);
    els.range.textContent = "Range: " + money(lo * travellers) + " to " + money(hi * travellers) + " (Budget to Comfortable)";
    els.perPerson.textContent = money(chosen);
    els.perDay.textContent = money(round5(chosen / days));
    els.budget.textContent = money(lo * travellers);
    els.middle.textContent = money(m * travellers);
    els.comfortable.textContent = money(hi * travellers);
    Array.prototype.forEach.call(els.breakdown.querySelectorAll("[data-style]"), function (d) {
      d.classList.toggle("is-selected", d.getAttribute("data-style") === style());
    });
    els.note.textContent = travellers > 1
      ? "Per-person estimate multiplied by " + travellers + ". Shared rooms can lower the lodging cost, so treat this as a cautious upper estimate. Flights are not included."
      : "Lodging, meals, local transport and activities per person. Flights are not included.";

    var origin = els.from.value.trim();
    if (origin) {
      var q = "Flights from " + origin + " to " + city(trip.place);
      els.flights.innerHTML = "";
      var a = document.createElement("a");
      a.href = "https://www.google.com/travel/flights?q=" + encodeURIComponent(q);
      a.target = "_blank"; a.rel = "noopener noreferrer";
      a.textContent = "Search flights from " + origin + " to " + city(trip.place);
      els.flights.appendChild(a);
      els.flights.appendChild(document.createTextNode(" (opens Google Flights; flights are not in the estimate)"));
    } else {
      els.flights.textContent = "Enter your departure city to open a flight search for this trip.";
    }
    els.link.href = "/" + trip.id;
    els.link.textContent = "Open the " + trip.n + "-day itinerary";
    try {
      var p = new URLSearchParams({ trip: trip.id, days: String(days), travellers: String(travellers), style: style() });
      window.history.replaceState(null, "", "?" + p.toString());
    } catch (e) { /* ignore */ }
  }

  // read a shared link (?trip=&days=&travellers=&style=)
  try {
    var q = new URLSearchParams(window.location.search);
    var t = byId[q.get("trip")];
    if (t) { els.trip.value = t.id; fillDays(t, parseInt(q.get("days"), 10)); }
    var tv = parseInt(q.get("travellers"), 10);
    if (tv >= 1 && tv <= 8) els.trav.value = String(tv);
    var st = q.get("style");
    var radio = st && form.querySelector('input[name="calcStyle"][value="' + st + '"]');
    if (radio) radio.checked = true;
  } catch (e) { /* ignore */ }

  els.trip.addEventListener("change", function () {
    var t = byId[els.trip.value];
    if (t) fillDays(t, 0);
    render();
  });
  ["change", "input"].forEach(function (ev) { form.addEventListener(ev, function (e) { if (e.target !== els.trip) render(); }); });
  form.addEventListener("submit", function (e) { e.preventDefault(); render(); });
  window.addEventListener("currencychange", render);
  render();
})();
