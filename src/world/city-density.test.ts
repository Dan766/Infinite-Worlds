import { describe, expect, it } from "vitest";
import { parseParams } from "../core/params";
import { worldRegionField, worldSectorField } from "./height-field";
import { cityPlanAt, isCity } from "./city";
import { KIND_TOWNHOUSE } from "./lots";
import { SECTOR_SIZE } from "./contracts";

describe("city density", () => {
  it("packs street metres and lots above village-grade floors", () => {
    const seed = parseParams("").seedHash;
    const region = worldRegionField(seed);
    const field = worldSectorField(region, seed);
    const net = region.roads.networkAt(-32612, -28480);
    const city = net.settlements.find(isCity)!;
    const plan = cityPlanAt(city, seed)!;
    let streetM = 0;
    for (let s = 0; s < plan.streetCount; s++) {
      const from = plan.streetStart[s]!;
      const to = plan.streetStart[s + 1]!;
      for (let i = from; i + 1 < to; i++) {
        streetM += Math.hypot(
          (plan.nodeX[i + 1]! - plan.nodeX[i]!),
          (plan.nodeZ[i + 1]! - plan.nodeZ[i]!),
        );
      }
    }
    const R = plan.wallRadius;
    const areaHa = (Math.PI * R * R) / 10000;
    let lots = 0;
    let townhouses = 0;
    const s0 = Math.floor((plan.centerX - R) / SECTOR_SIZE);
    const s1 = Math.floor((plan.centerX + R) / SECTOR_SIZE);
    const z0 = Math.floor((plan.centerZ - R) / SECTOR_SIZE);
    const z1 = Math.floor((plan.centerZ + R) / SECTOR_SIZE);
    for (let sz = z0; sz <= z1; sz++) {
      for (let sx = s0; sx <= s1; sx++) {
        const rec = field.lots.lotsAt(sx, sz);
        for (let i = 0; i < rec.count; i++) {
          const dx = rec.centerX[i]! - plan.centerX;
          const dz = rec.centerZ[i]! - plan.centerZ;
          if (dx * dx + dz * dz > R * R) continue;
          lots++;
          if (rec.kind[i] === KIND_TOWNHOUSE) townhouses++;
        }
      }
    }
    console.log({ streetM: streetM.toFixed(0), lots, townhouses, areaHa: areaHa.toFixed(1), mPerHa: (streetM / areaHa).toFixed(0), lotsPerHa: (lots / areaHa).toFixed(1) });
    // Floors from density epic — below proposed ACCEPT but well above old ~4.3/ha / ~80 m/ha
    expect(streetM).toBeGreaterThan(24000);
    expect(lots).toBeGreaterThan(2500);
    expect(townhouses).toBeGreaterThan(2000);
    // Along-street abutting (same row): nearest neighbor along facing, not across street.
    // Same-row runs should abut after the full-CityPlan station walk (CSR clip holes closed).
    let abut = 0;
    let considered = 0;
    const th: { x: number; z: number; hw: number; ax: number; az: number }[] = [];
    for (let sz = z0; sz <= z1; sz++) {
      for (let sx = s0; sx <= s1; sx++) {
        const rec = field.lots.lotsAt(sx, sz);
        for (let i = 0; i < rec.count; i++) {
          if (rec.kind[i] !== KIND_TOWNHOUSE) continue;
          const dx = rec.centerX[i]! - plan.centerX;
          const dz = rec.centerZ[i]! - plan.centerZ;
          if (dx * dx + dz * dz > R * R) continue;
          th.push({
            x: rec.centerX[i]!, z: rec.centerZ[i]!, hw: rec.halfWidth[i]!,
            ax: rec.alongX[i]!, az: rec.alongZ[i]!,
          });
        }
      }
    }
    for (let i = 0; i < th.length; i++) {
      const a = th[i]!;
      let best = Infinity;
      let bestHw = 0;
      for (let j = 0; j < th.length; j++) {
        if (i === j) continue;
        const b = th[j]!;
        const ox = b.x - a.x;
        const oz = b.z - a.z;
        const across = ox * (-a.az) + oz * a.ax; // along × up → across
        if (across > 4 || across < -4) continue; // different row / other side
        const along = Math.abs(ox * a.ax + oz * a.az);
        if (along < best && along > 0.01) { best = along; bestHw = b.hw; }
      }
      // Score lots in a run (neighbor within ~2 pitches).
      if (best <= 11) {
        considered++;
        if (best <= a.hw + bestHw + 0.3) abut++;
      }
    }
    const abutPct = considered > 0 ? abut / considered : 0;
    console.log({ abutPct: abutPct.toFixed(2), considered });
    expect(abutPct).toBeGreaterThan(0.75);
  });
});