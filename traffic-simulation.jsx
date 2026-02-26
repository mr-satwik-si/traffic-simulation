import { useState, useEffect, useRef, useCallback } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const GRID = 12;
const CELL = 52;
const ROLLING_WINDOW = 120;
// How many sim-ticks represent 1 real-world second (tune for realism)
const TICKS_PER_SECOND = 20;

// ─── Pure helpers ─────────────────────────────────────────────────────────────
function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function generateGrid() {
  const rng = seededRandom(42);
  return Array.from({ length: GRID }, (_, r) =>
    Array.from({ length: GRID }, (_, c) => {
      if (r === 0 || r === GRID - 1 || c === 0 || c === GRID - 1) return true;
      if (r % 3 === 0 || c % 3 === 0) return true;
      return rng() < 0.11;
    })
  );
}
const ROAD_GRID = generateGrid();

function findAllIntersections() {
  const list = [];
  for (let r = 1; r < GRID - 1; r++)
    for (let c = 1; c < GRID - 1; c++) {
      if (!ROAD_GRID[r][c]) continue;
      const n = [ROAD_GRID[r-1]?.[c],ROAD_GRID[r+1]?.[c],ROAD_GRID[r]?.[c-1],ROAD_GRID[r]?.[c+1]].filter(Boolean).length;
      if (n >= 3) list.push({ r, c, id: `${r}-${c}` });
    }
  return list;
}
const ALL_INTERSECTIONS = findAllIntersections();

function pickIntersections(count) {
  const n = Math.min(count, ALL_INTERSECTIONS.length);
  if (n >= ALL_INTERSECTIONS.length) return [...ALL_INTERSECTIONS];
  const step = ALL_INTERSECTIONS.length / n;
  return Array.from({ length: n }, (_, i) => ALL_INTERSECTIONS[Math.floor(i * step)]);
}

function makeSignals(intersections) {
  return intersections.map((inter, idx) => ({
    ...inter, phase: idx % 4,
    timer: Math.floor((idx * 7) % 35),
    nsGreen: 30, ewGreen: 30,
  }));
}

function getRoadCells() {
  const cells = [];
  for (let r = 0; r < GRID; r++)
    for (let c = 0; c < GRID; c++)
      if (ROAD_GRID[r][c]) cells.push({ r, c });
  return cells;
}
const ROAD_CELLS = getRoadCells();

function spawnVehicles(count, seed = 99) {
  const rng = seededRandom(seed);
  const dirs = ["N","S","E","W"];
  return Array.from({ length: count }, (_, i) => {
    const pos = ROAD_CELLS[Math.floor(rng() * ROAD_CELLS.length)];
    return {
      id: i,
      r: pos.r + rng() * 0.6 - 0.3,
      c: pos.c + rng() * 0.6 - 0.3,
      dir: dirs[Math.floor(rng() * 4)],
      speed: 0.022 + rng() * 0.028,
      hue: Math.floor(rng() * 60 + 180),
      waiting: false,
      waitTicks: 0,
      totalWaitTicks: 0,   // cumulative wait over entire run
    };
  });
}

function stepSimulation(veh, sigs) {
  const newSigs = sigs.map((s) => {
    let { phase, timer, nsGreen, ewGreen } = s;
    const durations = [nsGreen, 5, ewGreen, 5];
    if (++timer >= durations[phase]) { phase = (phase + 1) % 4; timer = 0; }
    return { ...s, phase, timer };
  });

  const sigMap = {};
  newSigs.forEach(s => { sigMap[`${s.r}-${s.c}`] = s; });

  const newHeat = Array.from({ length: GRID }, () => Array(GRID).fill(0));
  const newVeh = veh.map((v) => {
    let { r, c, dir, speed, waitTicks, totalWaitTicks } = v;
    const sig = sigMap[`${Math.round(r)}-${Math.round(c)}`];
    let blocked = false;
    if (sig) {
      const ph = sig.phase;
      if ((dir==="N"||dir==="S") && (ph===2||ph===3)) blocked = true;
      if ((dir==="E"||dir==="W") && (ph===0||ph===1)) blocked = true;
    }
    waitTicks = blocked ? waitTicks + 1 : 0;
    totalWaitTicks = totalWaitTicks + (blocked ? 1 : 0);

    if (!blocked) {
      if (dir==="N") r-=speed; else if (dir==="S") r+=speed;
      else if (dir==="E") c+=speed; else c-=speed;
      if (r<0.5){r=0.5;dir="S";}  if (r>GRID-1.5){r=GRID-1.5;dir="N";}
      if (c<0.5){c=0.5;dir="E";}  if (c>GRID-1.5){c=GRID-1.5;dir="W";}
      if (ROAD_GRID[Math.round(r)]?.[Math.round(c)] && Math.random()<0.008) {
        const ds=["N","S","E","W"]; dir=ds[Math.floor(Math.random()*4)];
      }
    }
    const hr=Math.min(GRID-1,Math.max(0,Math.round(r)));
    const hc=Math.min(GRID-1,Math.max(0,Math.round(c)));
    newHeat[hr][hc]++;
    return { ...v, r, c, dir, waiting: blocked, waitTicks, totalWaitTicks };
  });

  const load = {};
  newSigs.forEach(s => {
    load[s.id] = Math.min(1, newVeh.filter(v=>Math.abs(v.r-s.r)<1.5&&Math.abs(v.c-s.c)<1.5).length/8);
    load[`${s.id}_ns`] = Math.min(1, newVeh.filter(v=>Math.abs(v.r-s.r)<1.5&&Math.abs(v.c-s.c)<0.8).length/5);
    load[`${s.id}_ew`] = Math.min(1, newVeh.filter(v=>Math.abs(v.r-s.r)<0.8&&Math.abs(v.c-s.c)<1.5).length/5);
  });

  const avgWait = newVeh.reduce((a,v)=>a+v.waitTicks,0) / Math.max(1,newVeh.length);
  return { newVeh, newSigs, newHeat, load, avgWait };
}

function aiOptimize(sigs, load) {
  return sigs.map(s => ({
    ...s,
    nsGreen: Math.round(15 + (load[`${s.id}_ns`]||0.5)*45),
    ewGreen: Math.round(15 + (load[`${s.id}_ew`]||0.5)*45),
  }));
}

// Fast-forward N ticks without rendering — returns final vehicles with cumulative wait
function fastForwardSim(initVeh, initSigs, totalTicks, useAi = false) {
  let veh  = initVeh.map(v => ({ ...v, totalWaitTicks: 0 }));
  let sigs = initSigs;
  let load = {};
  for (let t = 0; t < totalTicks; t++) {
    const res = stepSimulation(veh, sigs);
    veh  = res.newVeh;
    sigs = useAi ? aiOptimize(res.newSigs, res.load) : res.newSigs;
    load = res.load;
  }
  // avg wait in ticks → convert to seconds
  const totalWaitTicks = veh.reduce((a,v)=>a+v.totalWaitTicks,0);
  const avgWaitTicks   = totalWaitTicks / Math.max(1, veh.length);
  const avgWaitSec     = avgWaitTicks / TICKS_PER_SECOND;
  const maxWaitSec     = Math.max(...veh.map(v=>v.totalWaitTicks)) / TICKS_PER_SECOND;
  const pctWaiting     = veh.filter(v=>v.waiting).length / veh.length * 100;
  return { veh, sigs, load, avgWaitSec, maxWaitSec, pctWaiting, totalTicks };
}

function fmtTime(sec) {
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60), s = (sec % 60).toFixed(0).padStart(2,"0");
  return `${m}m ${s}s`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function Sparkline({ data, color, width=180, height=38 }) {
  if (data.length<2) return <div style={{ width, height, background:`${color}10`, borderRadius:3 }} />;
  const max=Math.max(...data,0.01), min=Math.min(...data,0), range=max-min||0.01;
  const pts = data.map((v,i) => {
    const x=(i/(data.length-1))*width;
    const y=height-((v-min)/range)*(height-4)-2;
    return `${x},${y}`;
  }).join(" ");
  const uid=color.replace("#","");
  return (
    <svg width={width} height={height} style={{ display:"block" }}>
      <defs>
        <linearGradient id={`g${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polygon points={`0,${height} ${pts} ${width},${height}`} fill={`url(#g${uid})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function Slider({ label, value, min, max, step, unit, onChange, color="#00e5ff" }) {
  return (
    <div style={{ marginBottom:14 }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:5 }}>
        <span style={{ fontSize:10, color:"#8a9bb0", letterSpacing:"0.12em" }}>{label}</span>
        <span style={{ fontSize:13, fontWeight:700, color, textShadow:`0 0 8px ${color}55` }}>{value}{unit}</span>
      </div>
      <div style={{ position:"relative", height:20, display:"flex", alignItems:"center" }}>
        <div style={{ position:"absolute", width:"100%", height:4, background:"#1c2a3a", borderRadius:2 }} />
        <div style={{ position:"absolute", height:4, borderRadius:2, width:`${((value-min)/(max-min))*100}%`, background:`linear-gradient(90deg,${color}88,${color})` }} />
        <input type="range" min={min} max={max} step={step} value={value}
          onChange={e=>onChange(Number(e.target.value))}
          style={{ position:"absolute", width:"100%", opacity:0, cursor:"pointer", height:20, margin:0 }} />
        <div style={{ position:"absolute", left:`calc(${((value-min)/(max-min))*100}% - 7px)`, width:14, height:14, borderRadius:"50%", background:color, boxShadow:`0 0 8px ${color}`, border:"2px solid #080c14", pointerEvents:"none" }} />
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", marginTop:2 }}>
        <span style={{ fontSize:9, color:"#2a3a4a" }}>{min}{unit}</span>
        <span style={{ fontSize:9, color:"#2a3a4a" }}>{max}{unit}</span>
      </div>
    </div>
  );
}

// ── Tooltip helper ────────────────────────────────────────────────────────────
function Tip({ text }) {
  const [show, setShow] = useState(false);
  return (
    <span style={{ position:"relative", display:"inline-block", marginLeft:5 }}>
      <span
        onMouseEnter={()=>setShow(true)} onMouseLeave={()=>setShow(false)}
        style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", width:14, height:14, borderRadius:"50%", background:"#1c2a3a", color:"#4a6080", fontSize:9, cursor:"help", border:"1px solid #2a3a4a", userSelect:"none" }}>?</span>
      {show && (
        <div style={{ position:"absolute", bottom:"calc(100% + 6px)", left:"50%", transform:"translateX(-50%)", background:"#0d1117", border:"1px solid #00e5ff44", borderRadius:6, padding:"8px 10px", fontSize:10, color:"#c8d6ef", width:200, zIndex:100, lineHeight:1.6, whiteSpace:"normal", boxShadow:"0 4px 20px #00000088" }}>
          {text}
          <div style={{ position:"absolute", bottom:-5, left:"50%", transform:"translateX(-50%)", width:8, height:8, background:"#0d1117", border:"1px solid #00e5ff44", borderTop:"none", borderLeft:"none", rotate:"45deg" }} />
        </div>
      )}
    </span>
  );
}

// ── Step badge ────────────────────────────────────────────────────────────────
function StepBadge({ n, color="#00e5ff" }) {
  return (
    <div style={{ width:22, height:22, borderRadius:"50%", background:`${color}22`, border:`1.5px solid ${color}`, color, fontSize:11, fontWeight:700, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>{n}</div>
  );
}

// ── Report Card ───────────────────────────────────────────────────────────────
function ReportCard({ result, vehicles, lights, durationMin }) {
  const [guideOpen, setGuideOpen] = useState(true);
  if (!result) return null;
  const { staticRes, aiRes } = result;
  const improvement    = (staticRes.avgWaitSec - aiRes.avgWaitSec) / Math.max(0.001, staticRes.avgWaitSec) * 100;
  const timeSaved      = staticRes.avgWaitSec - aiRes.avgWaitSec;
  const totalTimeSaved = timeSaved * vehicles;
  const cityScale      = Math.round(Math.max(0, timeSaved) * 500000 / 3600); // hrs saved for 500k commuters

  const rows = [
    {
      label:"Avg Wait / Vehicle",
      what:"The average time each vehicle spends stopped at a red light across the entire simulation.",
      why:"This is the headline metric. Lower = better traffic flow. AI wins by adapting green-light duration to how many cars are actually waiting.",
      static: fmtTime(staticRes.avgWaitSec), ai: fmtTime(aiRes.avgWaitSec), delta: improvement,
    },
    {
      label:"Max Wait (worst vehicle)",
      what:"The longest any single vehicle had to wait at red lights during the entire run.",
      why:"Shows the worst-case experience. High max wait = some intersections are heavily congested. AI reduces this by giving more green time where queues are longest.",
      static: fmtTime(staticRes.maxWaitSec), ai: fmtTime(aiRes.maxWaitSec),
      delta: (staticRes.maxWaitSec - aiRes.maxWaitSec) / Math.max(0.001, staticRes.maxWaitSec) * 100,
    },
    {
      label:"% Vehicles Waiting at end",
      what:"At the final snapshot of the simulation, what percentage of vehicles are stopped at a red light.",
      why:"A high % means congestion is building up. If AI keeps this low, it means the city is flowing smoothly — fewer queue pile-ups.",
      static:`${staticRes.pctWaiting.toFixed(1)}%`, ai:`${aiRes.pctWaiting.toFixed(1)}%`,
      delta: staticRes.pctWaiting - aiRes.pctWaiting,
    },
  ];

  return (
    <div style={{ width:"100%", marginBottom:16 }}>

      {/* ── STEP-BY-STEP GUIDE ── */}
      <div style={{ marginBottom:14, border:"1px solid #ffd70033", borderRadius:10, overflow:"hidden" }}>
        <button onClick={()=>setGuideOpen(o=>!o)} style={{ width:"100%", background:"#ffd70008", border:"none", borderBottom: guideOpen?"1px solid #ffd70022":"none", padding:"11px 18px", display:"flex", alignItems:"center", justifyContent:"space-between", cursor:"pointer", fontFamily:"inherit" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ fontSize:14 }}>📖</span>
            <span style={{ fontSize:11, color:"#ffd700", letterSpacing:"0.15em" }}>HOW TO READ THIS REPORT</span>
            <span style={{ fontSize:9, color:"#4a6080" }}>click to {guideOpen?"hide":"show"}</span>
          </div>
          <span style={{ color:"#ffd700", fontSize:14 }}>{guideOpen?"▲":"▼"}</span>
        </button>

        {guideOpen && (
          <div style={{ background:"#080c14", padding:"16px 18px" }}>

            {/* What was simulated */}
            <div style={{ marginBottom:14, padding:"10px 14px", background:"#0d1117", border:"1px solid #1c2a3a", borderRadius:8 }}>
              <div style={{ fontSize:10, color:"#00e5ff", letterSpacing:"0.15em", marginBottom:6 }}>📌 WHAT WAS SIMULATED</div>
              <div style={{ fontSize:11, color:"#8a9bb0", lineHeight:1.8 }}>
                Two <strong style={{ color:"#c8d6ef" }}>identical city grids</strong> ran side-by-side for <strong style={{ color:"#ffd700" }}>{durationMin} minute{durationMin!==1?"s":""}</strong> with <strong style={{ color:"#ff8c42" }}>{vehicles} vehicles</strong> and <strong style={{ color:"#00ff88" }}>{lights} traffic lights</strong>.
                Every vehicle, every road, every starting position was <strong style={{ color:"#c8d6ef" }}>exactly the same</strong> — the only difference was the signal timing strategy.
                This is a controlled experiment, just like a scientific A/B test.
              </div>
            </div>

            {/* 4 steps */}
            <div style={{ fontSize:10, color:"#4a6080", letterSpacing:"0.15em", marginBottom:10 }}>🔢 READING THE REPORT — 4 STEPS</div>
            <div style={{ display:"flex", flexDirection:"column", gap:10 }}>

              {[
                {
                  n:1, color:"#ff8c42",
                  title:"Compare the two big numbers (AVG WAIT)",
                  body:`The orange number is the Static system — fixed 30-second green lights at every intersection, no matter how many cars are waiting. The green number is the AI system. The difference between them is how much the AI improves traffic. If the orange is ${fmtTime(staticRes.avgWaitSec)} and the green is ${fmtTime(aiRes.avgWaitSec)}, every vehicle waited ${fmtTime(Math.abs(timeSaved))} ${timeSaved>0?"less":"more"} on average under AI control.`,
                },
                {
                  n:2, color:"#00e5ff",
                  title:`Check the AI GAIN % in the centre (${improvement.toFixed(1)}%)`,
                  body:`This is the headline improvement number. It means the AI reduced average waiting time by ${improvement.toFixed(1)}% compared to static timing. ${improvement>15?"This is a strong result — above 15% is considered significant in traffic engineering.":improvement>5?"This is a solid result. Anything above 5% is meaningful at city scale.":"Even small % gains translate to thousands of hours saved across a whole city."}`,
                },
                {
                  n:3, color:"#00ff88",
                  title:"Look at the comparison table (3 metrics)",
                  body:"The table shows Avg Wait, Max Wait, and % Waiting at the end. Green ↓ means AI improved that metric. The most important is Avg Wait because it affects every single commuter. Max Wait tells you about worst-case congestion pockets — if AI reduces it, no intersection is becoming a bottleneck.",
                },
                {
                  n:4, color:"#ffd700",
                  title:"Read the Real-World Impact section at the bottom",
                  body:`This scales the simulation result to a realistic city. If AI saves ${fmtTime(Math.max(0,timeSaved))} per vehicle per ${durationMin} minutes, that saves roughly ${cityScale.toLocaleString()} hours per day across 500,000 daily commuters. This is the number you use to justify the project to a city council.`,
                },
              ].map(step => (
                <div key={step.n} style={{ display:"flex", gap:12, background:"#0d1117", border:`1px solid ${step.color}22`, borderLeft:`3px solid ${step.color}`, borderRadius:6, padding:"10px 14px" }}>
                  <StepBadge n={step.n} color={step.color} />
                  <div>
                    <div style={{ fontSize:10, fontWeight:700, color:step.color, marginBottom:4, letterSpacing:"0.05em" }}>{step.title}</div>
                    <div style={{ fontSize:10, color:"#7a92b0", lineHeight:1.7 }}>{step.body}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Quick glossary */}
            <div style={{ marginTop:14, padding:"10px 14px", background:"#0d1117", border:"1px solid #1c2a3a", borderRadius:8 }}>
              <div style={{ fontSize:10, color:"#4a6080", letterSpacing:"0.15em", marginBottom:8 }}>📚 QUICK GLOSSARY</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"6px 20px" }}>
                {[
                  ["Static timing","Fixed green/red durations — no adaptation. What 90% of cities use today."],
                  ["AI optimized","Green duration adjusts every tick based on how many cars are queued NS vs EW."],
                  ["Avg Wait","Sum of all wait ticks ÷ number of vehicles ÷ ticks-per-second. Shown in real time."],
                  ["Max Wait","The single vehicle that waited the longest. Reflects worst intersection bottleneck."],
                  ["% Waiting","Snapshot at end of run — what fraction of vehicles are currently stopped."],
                  ["AI Gain %","(Static − AI) ÷ Static × 100. Positive = AI is better. Negative = AI is worse."],
                  ["Total Delay","Avg wait × number of vehicles. Total productive time lost across the whole fleet."],
                  ["Ticks","Internal simulation time steps. 20 ticks = 1 real-world second in this model."],
                ].map(([term, def]) => (
                  <div key={term} style={{ fontSize:9, lineHeight:1.6 }}>
                    <span style={{ color:"#00e5ff", fontWeight:700 }}>{term}: </span>
                    <span style={{ color:"#4a6080" }}>{def}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── REPORT HEADER ── */}
      <div style={{ background:"linear-gradient(90deg,#00e5ff0a,transparent)", border:"1px solid #00e5ff33", borderRadius:"10px 10px 0 0", padding:"12px 20px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div>
          <div style={{ fontSize:11, color:"#00e5ff", letterSpacing:"0.2em", marginBottom:2 }}>📋 SIMULATION REPORT</div>
          <div style={{ fontSize:10, color:"#4a6080" }}>{durationMin} min · {vehicles} vehicles · {lights} traffic lights</div>
        </div>
        <div style={{ textAlign:"right" }}>
          <div style={{ fontSize:9, color:"#4a6080", letterSpacing:"0.15em" }}>AI SAVES PER VEHICLE</div>
          <div style={{ fontSize:22, fontWeight:700, color:timeSaved>0?"#00ff88":"#ff4466", textShadow:timeSaved>0?"0 0 14px #00ff8866":"none" }}>
            {timeSaved>0?"−":"+"}{fmtTime(Math.abs(timeSaved))}
          </div>
          <div style={{ fontSize:9, color:"#4a6080" }}>of waiting time</div>
        </div>
      </div>

      {/* ── MAIN 3-COL COMPARISON ── */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr auto 1fr", border:"1px solid #1c2a3a", borderTop:"none", background:"#0d1117" }}>

        {/* Static */}
        <div style={{ padding:"16px 18px", borderRight:"1px solid #1c2a3a" }}>
          <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:6 }}>
            <div style={{ width:8,height:8,borderRadius:"50%",background:"#ff8c42",boxShadow:"0 0 8px #ff8c42" }} />
            <span style={{ fontSize:10, letterSpacing:"0.18em", color:"#8a9bb0" }}>STATIC TIMING</span>
          </div>
          <div style={{ fontSize:9, color:"#4a6060", marginBottom:8, fontStyle:"italic" }}>Fixed 30s green · no adaptation</div>
          <div style={{ fontSize:10, color:"#4a6080", marginBottom:2 }}>AVG WAIT / VEHICLE <Tip text="The average time each vehicle spent waiting at red lights. Measured across all vehicles over the full simulation duration." /></div>
          <div style={{ fontSize:42, fontWeight:700, color:"#ff8c42", textShadow:"0 0 20px #ff8c4244", lineHeight:1, marginBottom:3 }}>{fmtTime(staticRes.avgWaitSec)}</div>
          <div style={{ fontSize:9, color:"#4a6080", marginBottom:12 }}>over {durationMin} min · {vehicles} vehicles</div>
          <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
            <div style={{ fontSize:9, color:"#4a6080", letterSpacing:"0.1em", marginBottom:2 }}>OTHER METRICS</div>
            {[
              ["MAX WAIT",    fmtTime(staticRes.maxWaitSec), "#ff8c42", "The single vehicle that waited the longest. High value = a bottleneck intersection."],
              ["% WAITING",   `${staticRes.pctWaiting.toFixed(1)}%`, "#ff4466", "What % of vehicles were stopped at the final frame. High % = congested network."],
              ["TOTAL DELAY", fmtTime(staticRes.avgWaitSec * vehicles), "#ff8c4299", "Avg wait × all vehicles = total productive time lost across the entire fleet."],
            ].map(([lbl,val,col,tip])=>(
              <div key={lbl} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", background:"#080c14", borderRadius:5, padding:"5px 9px" }}>
                <span style={{ fontSize:9, color:"#4a6080" }}>{lbl}<Tip text={tip} /></span>
                <span style={{ fontSize:10, fontWeight:700, color:col }}>{val}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Centre */}
        <div style={{ background:"#080c14", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"16px 14px", gap:7, minWidth:96, borderRight:"1px solid #1c2a3a" }}>
          <div style={{ fontSize:9, color:"#4a6080", letterSpacing:"0.12em", textAlign:"center" }}>AI<br/>GAIN<Tip text="(Static − AI) ÷ Static × 100. Positive means AI reduced waiting time by this percentage." /></div>
          <div style={{ fontSize:30, fontWeight:700, lineHeight:1, color:improvement>0?"#00ff88":improvement<0?"#ff4466":"#ffd700", textShadow:improvement>0?"0 0 18px #00ff8888":"none" }}>
            {improvement>0?`−${improvement.toFixed(1)}%`:improvement<0?`+${Math.abs(improvement).toFixed(1)}%`:"0%"}
          </div>
          <div style={{ padding:"3px 10px", borderRadius:10, fontSize:9, letterSpacing:"0.08em", background:improvement>0?"#00ff8818":"#ff446618", border:`1px solid ${improvement>0?"#00ff8840":"#ff446640"}`, color:improvement>0?"#00ff88":"#ff4466" }}>
            {improvement>15?"MUCH BETTER":improvement>5?"BETTER":improvement>0?"SLIGHTLY BETTER":improvement<0?"WORSE":"EQUAL"}
          </div>
          <div style={{ width:1, height:16, background:"#1c2a3a" }} />
          <div style={{ fontSize:9, color:"#4a6080", textAlign:"center" }}>FLEET<br/>TIME SAVED<Tip text="Avg time saved per vehicle × number of vehicles. Total delay eliminated from the system." /></div>
          <div style={{ fontSize:14, fontWeight:700, color:totalTimeSaved>0?"#00ff88":"#ff4466" }}>
            {totalTimeSaved>0?"−":"+"}{fmtTime(Math.abs(totalTimeSaved))}
          </div>
          <div style={{ width:1, height:16, background:"#1c2a3a" }} />
          <div style={{ fontSize:9, color:"#4a6080", textAlign:"center" }}>CITY SCALE<br/>DAILY<Tip text="If 500,000 commuters used this system daily, this is how many hours of waiting time would be eliminated." /></div>
          <div style={{ fontSize:12, fontWeight:700, color:"#00e5ff" }}>{cityScale.toLocaleString()} hrs</div>
          <div style={{ fontSize:8, color:"#2a3a4a", textAlign:"center" }}>saved/day<br/>500k commuters</div>
        </div>

        {/* AI */}
        <div style={{ padding:"16px 18px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:6 }}>
            <div style={{ width:8,height:8,borderRadius:"50%",background:"#00ff88",boxShadow:"0 0 8px #00ff88",animation:"pulse 2s infinite" }} />
            <span style={{ fontSize:10, letterSpacing:"0.18em", color:"#8a9bb0" }}>AI OPTIMIZED</span>
            <span style={{ fontSize:8, padding:"1px 6px", borderRadius:8, background:"#00ff8818", border:"1px solid #00ff8840", color:"#00ff88" }}>ML</span>
          </div>
          <div style={{ fontSize:9, color:"#4a6060", marginBottom:8, fontStyle:"italic" }}>Adaptive green · demand-weighted</div>
          <div style={{ fontSize:10, color:"#4a6080", marginBottom:2 }}>AVG WAIT / VEHICLE <Tip text="Same metric as Static — average wait per vehicle — but with AI-controlled signals that adjust green duration based on real-time queue lengths." /></div>
          <div style={{ fontSize:42, fontWeight:700, color:"#00ff88", textShadow:"0 0 20px #00ff8844", lineHeight:1, marginBottom:3 }}>{fmtTime(aiRes.avgWaitSec)}</div>
          <div style={{ fontSize:9, color:"#4a6080", marginBottom:12 }}>over {durationMin} min · {vehicles} vehicles</div>
          <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
            <div style={{ fontSize:9, color:"#4a6080", letterSpacing:"0.1em", marginBottom:2 }}>OTHER METRICS</div>
            {[
              ["MAX WAIT",    fmtTime(aiRes.maxWaitSec), "#00ff88", "AI max wait — ideally lower than Static, showing no single intersection became a severe bottleneck."],
              ["% WAITING",   `${aiRes.pctWaiting.toFixed(1)}%`, "#00cc66", "AI % waiting — lower means fewer vehicles sitting idle at the end of the run."],
              ["TOTAL DELAY", fmtTime(aiRes.avgWaitSec * vehicles), "#00ff8899", "Total fleet delay under AI. Compare to Static's total delay to see the full scale of improvement."],
            ].map(([lbl,val,col,tip])=>(
              <div key={lbl} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", background:"#080c14", borderRadius:5, padding:"5px 9px" }}>
                <span style={{ fontSize:9, color:"#4a6080" }}>{lbl}<Tip text={tip} /></span>
                <span style={{ fontSize:10, fontWeight:700, color:col }}>{val}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── ANNOTATED COMPARISON TABLE ── */}
      <div style={{ border:"1px solid #1c2a3a", borderTop:"none", overflow:"hidden" }}>
        <div style={{ background:"#080c14", padding:"8px 16px", borderBottom:"1px solid #1c2a3a" }}>
          <div style={{ fontSize:10, color:"#00e5ff", letterSpacing:"0.15em", marginBottom:2 }}>📊 METRIC-BY-METRIC BREAKDOWN</div>
          <div style={{ fontSize:9, color:"#4a6080" }}>Each row = one measurable dimension of traffic performance. Green ↓ = AI improved it.</div>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1.8fr 0.8fr 0.8fr 0.9fr", background:"#060a10", padding:"6px 16px", fontSize:9, color:"#4a6080", letterSpacing:"0.12em", borderBottom:"1px solid #1c2a3a" }}>
          <div>METRIC + WHAT IT MEANS</div>
          <div style={{ color:"#ff8c42" }}>🔴 STATIC</div>
          <div style={{ color:"#00ff88" }}>🟢 AI OPT</div>
          <div style={{ color:"#00e5ff" }}>RESULT</div>
        </div>
        {rows.map((row, i) => (
          <div key={row.label}>
            <div style={{ display:"grid", gridTemplateColumns:"1.8fr 0.8fr 0.8fr 0.9fr", padding:"9px 16px", background:i%2===0?"#0d1117":"#0a0d16", borderBottom:"1px solid #1c2a3a22", fontSize:10, alignItems:"start" }}>
              <div>
                <div style={{ color:"#c8d6ef", fontWeight:700, marginBottom:2 }}>{row.label}</div>
                <div style={{ fontSize:9, color:"#4a6080", lineHeight:1.5 }}>{row.what}</div>
              </div>
              <div style={{ color:"#ff8c42", fontWeight:700, paddingTop:2 }}>{row.static}</div>
              <div style={{ color:"#00ff88", fontWeight:700, paddingTop:2 }}>{row.ai}</div>
              <div style={{ paddingTop:2 }}>
                <div style={{ color:row.delta>0?"#00ff88":row.delta<0?"#ff4466":"#ffd700", fontWeight:700, marginBottom:3 }}>
                  {row.delta>0?`↓ ${row.delta.toFixed(1)}% better`:row.delta<0?`↑ ${Math.abs(row.delta).toFixed(1)}% worse`:"no change"}
                </div>
                <div style={{ fontSize:9, color:"#4a6080", lineHeight:1.5 }}>{row.why}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── REAL-WORLD IMPACT ── */}
      <div style={{ background:"#080c14", border:"1px solid #1c2a3a", borderTop:"none", padding:"14px 18px" }}>
        <div style={{ fontSize:10, color:"#ffd700", letterSpacing:"0.15em", marginBottom:4 }}>🌆 WHAT THIS MEANS FOR A REAL CITY</div>
        <div style={{ fontSize:9, color:"#4a6080", marginBottom:12 }}>Scaling the simulation result to real-world commuter numbers</div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10, marginBottom:12 }}>
          {[
            { icon:"⏱", label:"Saved per vehicle", value:fmtTime(Math.max(0,timeSaved)), sub:`per ${durationMin}-min journey`, explain:"This is the direct gain for one commuter. If they commute twice a day, double this." },
            { icon:"🚗", label:"Fleet delay saved", value:fmtTime(Math.max(0,totalTimeSaved)), sub:`all ${vehicles} vehicles`, explain:"Total time given back to all vehicles combined in this simulation run." },
            { icon:"🏙️", label:"City-scale daily", value:`${cityScale.toLocaleString()} hrs`, sub:"500k commuters", explain:"If half a million commuters benefit, this is how many hours of productivity are recovered each day." },
            { icon:"⛽", label:"Est. fuel savings", value:`~${Math.max(0,improvement*0.6).toFixed(0)}%`, sub:"less idle burning", explain:"Less time idling at lights = less fuel burned. Proportional to wait-time reduction." },
            { icon:"🌱", label:"CO₂ reduction", value:`~${Math.max(0,improvement*0.5).toFixed(0)}%`, sub:"emission estimate", explain:"Idling cars emit CO₂. Reducing idle time by this % proportionally reduces urban emissions." },
            { icon:"💰", label:"Cost saving", value:`~$${Math.round(Math.max(0,timeSaved/60*0.25*vehicles)).toLocaleString()}`, sub:"fuel + productivity", explain:"Rough estimate: $0.25/min per vehicle in fuel + productivity value. Scales massively at city level." },
          ].map(item=>(
            <div key={item.label} style={{ background:"#0d1117", border:"1px solid #1c2a3a", borderRadius:6, padding:"10px 12px" }}>
              <div style={{ fontSize:18, marginBottom:4 }}>{item.icon}</div>
              <div style={{ fontSize:9, color:"#4a6080", marginBottom:3, letterSpacing:"0.08em" }}>{item.label}</div>
              <div style={{ fontSize:18, fontWeight:700, color:"#00e5ff", marginBottom:2 }}>{item.value}</div>
              <div style={{ fontSize:8, color:"#2a3a4a", marginBottom:4 }}>{item.sub}</div>
              <div style={{ fontSize:8, color:"#3a5060", lineHeight:1.5, borderTop:"1px solid #1c2a3a", paddingTop:4 }}>{item.explain}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── VERDICT ── */}
      <div style={{ border:"1px solid #1c2a3a", borderTop:"none", borderRadius:"0 0 10px 10px", background: improvement>5?"#00ff8808":improvement<0?"#ff446608":"#ffd70008", padding:"14px 18px" }}>
        <div style={{ fontSize:10, color: improvement>5?"#00ff88":improvement<0?"#ff4466":"#ffd700", letterSpacing:"0.15em", marginBottom:8 }}>
          {improvement>15?"🏆 VERDICT: STRONG AI WIN":improvement>5?"✅ VERDICT: AI WINS":improvement>0?"🔶 VERDICT: SLIGHT AI WIN":improvement<0?"❌ VERDICT: STATIC WAS BETTER":"⚖️ VERDICT: NO DIFFERENCE"}
        </div>
        <div style={{ fontSize:10, color:"#8a9bb0", lineHeight:1.8 }}>
          {improvement>5
            ? `With ${vehicles} vehicles and ${lights} traffic lights, the AI system reduced average waiting time by ${improvement.toFixed(1)}% — from ${fmtTime(staticRes.avgWaitSec)} to ${fmtTime(aiRes.avgWaitSec)} per vehicle. This ${fmtTime(Math.max(0,timeSaved))} saving scales to approximately ${cityScale.toLocaleString()} hours recovered daily across a city of 500,000 commuters, with no additional infrastructure investment.`
            : improvement>0
            ? `The AI system showed a modest ${improvement.toFixed(1)}% improvement. Try increasing the number of vehicles (more congestion = more for AI to optimize) or running for longer to see stronger gains.`
            : `In this configuration, static and AI performed similarly. This typically happens with very few vehicles (low congestion gives the optimizer nothing to fix) or very few traffic lights. Try increasing vehicles to 100+ for a clearer difference.`
          }
        </div>
        {improvement<=0 && (
          <div style={{ marginTop:10, padding:"8px 12px", background:"#ffd70011", border:"1px solid #ffd70033", borderRadius:6, fontSize:9, color:"#ffd700" }}>
            💡 TIP: Increase vehicles to 100–200 and lights to 10+ for the most meaningful comparison. AI optimization shines when there is real congestion to manage.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function TrafficSim() {
  const canvasRef  = useRef(null);
  const heatmapRef = useRef(null);
  const animRef    = useRef(null);

  // ── Config ──────────────────────────────────────────────────────────────────
  const [pendingVehicles, setPendingVehicles] = useState(80);
  const [pendingLights,   setPendingLights]   = useState(12);
  const [appliedVehicles, setAppliedVehicles] = useState(80);
  const [appliedLights,   setAppliedLights]   = useState(12);
  const [configOpen,      setConfigOpen]      = useState(false);

  // ── Time analysis ────────────────────────────────────────────────────────────
  const [analysisDuration, setAnalysisDuration] = useState(5); // minutes
  const [analysisRunning,  setAnalysisRunning]  = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [reportResult,     setReportResult]     = useState(null);

  // ── Live simulation state ────────────────────────────────────────────────────
  const initInter = useRef(pickIntersections(12)).current;

  const [staticVeh,     setStaticVeh]     = useState(() => spawnVehicles(80));
  const [staticSigs,    setStaticSigs]    = useState(() => makeSignals(initInter));
  const [staticLoad,    setStaticLoad]    = useState({});
  const [staticWait,    setStaticWait]    = useState(0);
  const [staticHistory, setStaticHistory] = useState([]);

  const [aiVeh,     setAiVeh]     = useState(() => spawnVehicles(80));
  const [aiSigs,    setAiSigs]    = useState(() => makeSignals(initInter));
  const [aiLoad,    setAiLoad]    = useState({});
  const [aiWait,    setAiWait]    = useState(0);
  const [aiHistory, setAiHistory] = useState([]);

  const [heatmap,    setHeatmap]    = useState(() => Array.from({length:GRID},()=>Array(GRID).fill(0)));
  const [activeView, setActiveView] = useState("static");
  const [running,    setRunning]    = useState(true);
  const [tick,       setTick]       = useState(0);
  const [activeTab,  setActiveTab]  = useState("sim");

  const stateRef = useRef({});
  useEffect(() => { stateRef.current = { staticVeh, staticSigs, aiVeh, aiSigs }; });

  // ── Apply config ─────────────────────────────────────────────────────────────
  const applyConfig = useCallback(() => {
    const inter = pickIntersections(pendingLights);
    setStaticVeh(spawnVehicles(pendingVehicles)); setAiVeh(spawnVehicles(pendingVehicles));
    setStaticSigs(makeSignals(inter));           setAiSigs(makeSignals(inter));
    setStaticHistory([]); setAiHistory([]);
    setStaticWait(0);     setAiWait(0);
    setHeatmap(Array.from({length:GRID},()=>Array(GRID).fill(0)));
    setAppliedVehicles(pendingVehicles); setAppliedLights(pendingLights);
    setReportResult(null); setTick(0); setConfigOpen(false);
  }, [pendingVehicles, pendingLights]);

  // ── Run timed analysis (non-blocking via chunked setTimeout) ──────────────────
  const runAnalysis = useCallback(() => {
    setAnalysisRunning(true);
    setAnalysisProgress(0);
    setReportResult(null);

    const inter       = pickIntersections(appliedLights);
    const totalTicks  = analysisDuration * 60 * TICKS_PER_SECOND;
    const CHUNK       = 500; // ticks per chunk to avoid blocking UI
    const chunks      = Math.ceil(totalTicks / CHUNK);

    // Static sim state
    let sVeh  = spawnVehicles(appliedVehicles, 42);
    let sSigs = makeSignals(inter);

    // AI sim state
    let aVeh  = spawnVehicles(appliedVehicles, 42);
    let aSigs = makeSignals(inter);

    let chunkIdx = 0;

    function runChunk() {
      const ticksThisChunk = Math.min(CHUNK, totalTicks - chunkIdx * CHUNK);

      // static chunk
      for (let t = 0; t < ticksThisChunk; t++) {
        const r = stepSimulation(sVeh, sSigs);
        sVeh = r.newVeh; sSigs = r.newSigs;
      }
      // AI chunk
      for (let t = 0; t < ticksThisChunk; t++) {
        const r = stepSimulation(aVeh, aSigs);
        aVeh = r.newVeh; aSigs = aiOptimize(r.newSigs, r.load);
      }

      chunkIdx++;
      const pct = Math.round((chunkIdx / chunks) * 100);
      setAnalysisProgress(pct);

      if (chunkIdx < chunks) {
        setTimeout(runChunk, 0);
      } else {
        // Compute final stats
        const totalTW_s = sVeh.reduce((a,v)=>a+v.totalWaitTicks,0);
        const maxW_s    = Math.max(...sVeh.map(v=>v.totalWaitTicks));
        const pctW_s    = sVeh.filter(v=>v.waiting).length / sVeh.length * 100;

        const totalTW_a = aVeh.reduce((a,v)=>a+v.totalWaitTicks,0);
        const maxW_a    = Math.max(...aVeh.map(v=>v.totalWaitTicks));
        const pctW_a    = aVeh.filter(v=>v.waiting).length / aVeh.length * 100;

        setReportResult({
          staticRes: {
            avgWaitSec: totalTW_s / Math.max(1,sVeh.length) / TICKS_PER_SECOND,
            maxWaitSec: maxW_s / TICKS_PER_SECOND,
            pctWaiting: pctW_s,
          },
          aiRes: {
            avgWaitSec: totalTW_a / Math.max(1,aVeh.length) / TICKS_PER_SECOND,
            maxWaitSec: maxW_a / TICKS_PER_SECOND,
            pctWaiting: pctW_a,
          },
        });
        setAnalysisRunning(false);
        setAnalysisProgress(100);
        setActiveTab("report");
      }
    }
    setTimeout(runChunk, 10);
  }, [appliedVehicles, appliedLights, analysisDuration]);

  // ── Live step ────────────────────────────────────────────────────────────────
  const step = useCallback(() => {
    const { staticVeh:sv, staticSigs:ss, aiVeh:av, aiSigs:as_ } = stateRef.current;
    if (!sv||!ss||!av||!as_) return;
    const sr = stepSimulation(sv,ss);
    setStaticVeh(sr.newVeh); setStaticSigs(sr.newSigs);
    setStaticLoad(sr.load);  setStaticWait(sr.avgWait);
    setStaticHistory(h=>[...h.slice(-(ROLLING_WINDOW-1)), sr.avgWait]);
    const ar = stepSimulation(av,as_);
    const opt = aiOptimize(ar.newSigs,ar.load);
    setAiVeh(ar.newVeh); setAiSigs(opt);
    setAiLoad(ar.load);  setAiWait(ar.avgWait);
    setAiHistory(h=>[...h.slice(-(ROLLING_WINDOW-1)), ar.avgWait]);
    setHeatmap(activeView==="static"?sr.newHeat:ar.newHeat);
    setTick(t=>t+1);
  }, [activeView]);

  useEffect(() => {
    if (!running) return;
    const loop = () => { step(); animRef.current = requestAnimationFrame(loop); };
    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [running, step]);

  // ── Canvas render ────────────────────────────────────────────────────────────
  const drawSim = useCallback((ctx, veh, sigs, W) => {
    ctx.clearRect(0,0,W,W); ctx.fillStyle="#0d1117"; ctx.fillRect(0,0,W,W);
    for (let r=0;r<GRID;r++) for (let c=0;c<GRID;c++) {
      if (!ROAD_GRID[r][c]) continue;
      ctx.fillStyle="#1b2232"; ctx.fillRect(c*CELL+2,r*CELL+2,CELL-4,CELL-4);
      ctx.strokeStyle="#252f44"; ctx.lineWidth=0.5; ctx.setLineDash([4,4]);
      ctx.beginPath(); ctx.moveTo(c*CELL+CELL/2,r*CELL+2); ctx.lineTo(c*CELL+CELL/2,r*CELL+CELL-2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(c*CELL+2,r*CELL+CELL/2); ctx.lineTo(c*CELL+CELL-2,r*CELL+CELL/2); ctx.stroke();
      ctx.setLineDash([]);
    }
    sigs.forEach(s => {
      const x=s.c*CELL+CELL/2, y=s.r*CELL+CELL/2, ph=s.phase;
      const nc=ph===0?"#00ff88":ph===1?"#ffd700":"#ff4466";
      const ec=ph===2?"#00ff88":ph===3?"#ffd700":"#ff4466";
      [[-7,nc],[7,ec]].forEach(([dx,col])=>{
        ctx.beginPath(); ctx.arc(x+dx,y,4.5,0,Math.PI*2);
        ctx.fillStyle=col; ctx.shadowColor=col; ctx.shadowBlur=10; ctx.fill(); ctx.shadowBlur=0;
      });
    });
    veh.forEach(v => {
      const x=v.c*CELL+CELL/2, y=v.r*CELL+CELL/2;
      const ang={N:-Math.PI/2,S:Math.PI/2,E:0,W:Math.PI}[v.dir];
      ctx.save(); ctx.translate(x,y); ctx.rotate(ang);
      const col=v.waiting?"#ff4466":`hsl(${v.hue},80%,65%)`;
      ctx.fillStyle=col; ctx.shadowColor=col; ctx.shadowBlur=v.waiting?10:4;
      ctx.beginPath(); ctx.roundRect(-7,-4,14,8,2); ctx.fill();
      ctx.fillStyle="rgba(255,255,200,0.9)"; ctx.fillRect(5,-3,3,2); ctx.fillRect(5,1,3,2);
      ctx.shadowBlur=0; ctx.restore();
    });
  }, []);

  useEffect(() => {
    const canvas=canvasRef.current;
    if (!canvas||activeTab!=="sim") return;
    const ctx=canvas.getContext("2d");
    drawSim(ctx, activeView==="static"?staticVeh:aiVeh, activeView==="static"?staticSigs:aiSigs, GRID*CELL);
  }, [tick,activeView,staticVeh,aiVeh,staticSigs,aiSigs,activeTab,drawSim]);

  useEffect(() => {
    const canvas=heatmapRef.current;
    if (!canvas||activeTab!=="heat") return;
    const ctx=canvas.getContext("2d"); const W=GRID*CELL;
    ctx.clearRect(0,0,W,W); ctx.fillStyle="#0d1117"; ctx.fillRect(0,0,W,W);
    const maxV=Math.max(1,...heatmap.flat());
    for (let r=0;r<GRID;r++) for (let c=0;c<GRID;c++) {
      if (!ROAD_GRID[r][c]) continue;
      const t=heatmap[r][c]/maxV;
      ctx.fillStyle=`rgba(${Math.round(255*t)},${Math.round(80*(1-t))},${Math.round(180*(1-t))},${0.3+t*0.7})`;
      ctx.fillRect(c*CELL,r*CELL,CELL,CELL);
      if (t>0.15){ctx.fillStyle="rgba(255,255,255,0.5)";ctx.font="9px monospace";ctx.fillText(heatmap[r][c],c*CELL+4,r*CELL+14);}
    }
    const gr=ctx.createLinearGradient(W-20,20,W-20,W-20);
    gr.addColorStop(0,"#ff0040");gr.addColorStop(0.5,"#ff8800");gr.addColorStop(1,"#0044ff");
    ctx.fillStyle=gr;ctx.fillRect(W-18,20,12,W-40);
    ctx.strokeStyle="#ffffff33";ctx.strokeRect(W-18,20,12,W-40);
    ctx.fillStyle="#fff";ctx.font="10px monospace";ctx.fillText("H",W-17,15);ctx.fillText("L",W-16,W-5);
  }, [heatmap,activeTab]);

  // ── Computed ─────────────────────────────────────────────────────────────────
  const W = GRID*CELL;
  const sRolling = staticHistory.length>5?(staticHistory.reduce((a,b)=>a+b,0)/staticHistory.length).toFixed(2):"—";
  const aRolling = aiHistory.length>5?(aiHistory.reduce((a,b)=>a+b,0)/aiHistory.length).toFixed(2):"—";
  const improvement = staticHistory.length>5&&aiHistory.length>5
    ? Math.round((1-aiHistory.reduce((a,b)=>a+b,0)/Math.max(0.001,staticHistory.reduce((a,b)=>a+b,0)))*100) : null;
  const pendingChanged = pendingVehicles!==appliedVehicles||pendingLights!==appliedLights;
  const activeVeh  = activeView==="static"?staticVeh:aiVeh;
  const activeSigs = activeView==="static"?staticSigs:aiSigs;

  return (
    <div style={{ minHeight:"100vh", background:"#080c14", fontFamily:"'Courier New',monospace", color:"#c8d6ef", display:"flex", flexDirection:"column", alignItems:"center", padding:"16px 10px" }}>

      {/* ── Header ── */}
      <div style={{ width:"100%", maxWidth:760, marginBottom:14 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:4 }}>
          <div style={{ display:"flex", alignItems:"baseline", gap:10 }}>
            <span style={{ fontSize:20, fontWeight:700, letterSpacing:"0.12em", color:"#00e5ff", textShadow:"0 0 20px #00e5ff88" }}>NEXUS//TRAFFIC</span>
            <span style={{ fontSize:10, color:"#4a6080", letterSpacing:"0.2em" }}>AI OPTIMIZER v3.1</span>
          </div>
          <button onClick={()=>setConfigOpen(o=>!o)} style={{ background:configOpen?"#00e5ff18":"#0d1117", border:`1px solid ${configOpen?"#00e5ff":"#1c2a3a"}`, color:configOpen?"#00e5ff":"#4a6080", borderRadius:6, padding:"5px 14px", fontSize:11, letterSpacing:"0.1em", cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", gap:6 }}>
            ⚙ CONFIG {pendingChanged&&!configOpen&&<span style={{ width:6,height:6,borderRadius:"50%",background:"#ffd700",display:"inline-block",boxShadow:"0 0 6px #ffd700" }} />}
          </button>
        </div>
        <div style={{ height:1, background:"linear-gradient(90deg,#00e5ff44,transparent)" }} />
      </div>

      {/* ── Config Panel ── */}
      {configOpen && (
        <div style={{ width:"100%", maxWidth:760, marginBottom:14, background:"#0d1117", border:"1px solid #00e5ff33", borderRadius:10, overflow:"hidden" }}>
          <div style={{ background:"#00e5ff0a", borderBottom:"1px solid #1c2a3a", padding:"10px 20px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <span style={{ fontSize:11, color:"#00e5ff", letterSpacing:"0.2em" }}>⚙ SIMULATION CONFIG</span>
            <span style={{ fontSize:10, color:"#4a6080" }}>Changes apply on → APPLY</span>
          </div>
          <div style={{ padding:"20px 24px", display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0 40px" }}>
            <div>
              <div style={{ fontSize:9, color:"#4a6080", letterSpacing:"0.2em", marginBottom:16 }}>🚗 VEHICLES</div>
              <Slider label="NUMBER OF VEHICLES" value={pendingVehicles} min={10} max={300} step={10} unit=" veh" color="#ff8c42" onChange={setPendingVehicles} />
              <div style={{ display:"flex", gap:6, marginTop:-6, marginBottom:10 }}>
                {[20,50,80,150,200,300].map(v=>(
                  <button key={v} onClick={()=>setPendingVehicles(v)} style={{ background:pendingVehicles===v?"#ff8c4222":"#0a0e1a", border:`1px solid ${pendingVehicles===v?"#ff8c42":"#1c2a3a"}`, color:pendingVehicles===v?"#ff8c42":"#4a6080", borderRadius:4, padding:"3px 8px", fontSize:9, cursor:"pointer", fontFamily:"inherit" }}>{v}</button>
                ))}
              </div>
              <div style={{ background:"#080c14", borderRadius:6, padding:"8px 12px", border:"1px solid #1c2a3a" }}>
                <div style={{ fontSize:9, color:"#4a6080", marginBottom:4 }}>PREVIEW</div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:2 }}>
                  {Array.from({length:Math.min(pendingVehicles,60)},(_,i)=>(
                    <div key={i} style={{ width:6,height:6,borderRadius:1,background:`hsl(${(i*37)%360},70%,60%)`,opacity:0.8 }} />
                  ))}
                  {pendingVehicles>60&&<span style={{ fontSize:9,color:"#4a6080",alignSelf:"center",marginLeft:2 }}>+{pendingVehicles-60}</span>}
                </div>
              </div>
            </div>
            <div>
              <div style={{ fontSize:9, color:"#4a6080", letterSpacing:"0.2em", marginBottom:16 }}>🚦 TRAFFIC LIGHTS</div>
              <Slider label="NUMBER OF TRAFFIC LIGHTS" value={pendingLights} min={2} max={ALL_INTERSECTIONS.length} step={1} unit=" lights" color="#00ff88" onChange={setPendingLights} />
              <div style={{ display:"flex", gap:6, marginTop:-6, marginBottom:10 }}>
                {[4,8,12,16,20,ALL_INTERSECTIONS.length].map(v=>(
                  <button key={v} onClick={()=>setPendingLights(Math.min(v,ALL_INTERSECTIONS.length))} style={{ background:pendingLights===Math.min(v,ALL_INTERSECTIONS.length)?"#00ff8822":"#0a0e1a", border:`1px solid ${pendingLights===Math.min(v,ALL_INTERSECTIONS.length)?"#00ff88":"#1c2a3a"}`, color:pendingLights===Math.min(v,ALL_INTERSECTIONS.length)?"#00ff88":"#4a6080", borderRadius:4, padding:"3px 8px", fontSize:9, cursor:"pointer", fontFamily:"inherit" }}>{Math.min(v,ALL_INTERSECTIONS.length)}</button>
                ))}
              </div>
              <div style={{ background:"#080c14", borderRadius:6, padding:"8px 12px", border:"1px solid #1c2a3a" }}>
                <div style={{ fontSize:9, color:"#4a6080", marginBottom:4 }}>INTERSECTIONS ACTIVE</div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:3 }}>
                  {Array.from({length:pendingLights},(_,i)=>(
                    <div key={i} style={{ display:"flex",gap:1,alignItems:"center" }}>
                      <div style={{ width:5,height:5,borderRadius:"50%",background:"#00ff88",boxShadow:"0 0 4px #00ff88" }} />
                      <div style={{ width:5,height:5,borderRadius:"50%",background:"#ff4466",boxShadow:"0 0 4px #ff4466" }} />
                    </div>
                  ))}
                </div>
                <div style={{ fontSize:9,color:"#4a6080",marginTop:4 }}>{pendingLights} of {ALL_INTERSECTIONS.length} available</div>
              </div>
            </div>
          </div>
          <div style={{ padding:"12px 24px 16px", display:"flex", gap:10, justifyContent:"flex-end", borderTop:"1px solid #1c2a3a" }}>
            <button onClick={()=>{setPendingVehicles(appliedVehicles);setPendingLights(appliedLights);setConfigOpen(false);}} style={btnStyle(false,"#4a6080")}>CANCEL</button>
            <button onClick={applyConfig} style={{ ...btnStyle(true,"#00e5ff"), padding:"8px 28px", boxShadow:pendingChanged?"0 0 20px #00e5ff44":"none" }}>
              ▶ APPLY & RESTART {pendingChanged?"✦":""}
            </button>
          </div>
        </div>
      )}

      {/* ── Status badge strip ── */}
      <div style={{ width:"100%", maxWidth:760, display:"flex", gap:8, marginBottom:12, flexWrap:"wrap" }}>
        {[
          {label:"VEHICLES",       value:appliedVehicles,  color:"#ff8c42"},
          {label:"TRAFFIC LIGHTS", value:appliedLights,    color:"#00ff88"},
          {label:"MOVING",         value:activeVeh.filter(v=>!v.waiting).length, color:"#00e5ff"},
          {label:"WAITING",        value:activeVeh.filter(v=>v.waiting).length,  color:"#ff4466"},
        ].map(b=>(
          <div key={b.label} style={{ background:"#0d1117", border:"1px solid #1c2a3a", borderRadius:6, padding:"5px 12px", display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ fontSize:9, color:"#4a6080", letterSpacing:"0.12em" }}>{b.label}</span>
            <span style={{ fontSize:15, fontWeight:700, color:b.color, textShadow:`0 0 8px ${b.color}55` }}>{b.value}</span>
          </div>
        ))}
      </div>

      {/* ── Live wait comparison panel ── */}
      <div style={{ width:"100%", maxWidth:760, display:"grid", gridTemplateColumns:"1fr auto 1fr", marginBottom:14, border:"1px solid #1c2a3a", borderRadius:10, overflow:"hidden" }}>
        {/* Static */}
        <div style={{ background:"#0d1117", padding:"16px 20px", borderRight:"1px solid #1c2a3a" }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
            <div style={{ width:8,height:8,borderRadius:"50%",background:"#ff8c42",boxShadow:"0 0 8px #ff8c42" }} />
            <span style={{ fontSize:10, letterSpacing:"0.2em", color:"#8a9bb0" }}>STATIC TIMING</span>
          </div>
          <div style={{ fontSize:10, color:"#4a6080", marginBottom:3 }}>AVG WAITING TIME</div>
          <div style={{ display:"flex", alignItems:"baseline", gap:8, marginBottom:5 }}>
            <span style={{ fontSize:34, fontWeight:700, color:"#ff8c42", textShadow:"0 0 16px #ff8c4255", lineHeight:1 }}>{sRolling}</span>
            <span style={{ fontSize:10, color:"#4a6080" }}>ticks/veh</span>
          </div>
          <div style={{ fontSize:9, color:"#4a606088", marginBottom:8 }}>Fixed: NS 30s · EW 30s</div>
          <Sparkline data={staticHistory} color="#ff8c42" />
          <div style={{ marginTop:8, display:"flex", gap:14, fontSize:9 }}>
            <span><span style={{ color:"#4a6080" }}>NOW </span><span style={{ color:"#ff8c42",fontWeight:700 }}>{staticWait.toFixed(2)}</span></span>
            <span><span style={{ color:"#4a6080" }}>WAIT </span><span style={{ color:"#ff4466",fontWeight:700 }}>{staticVeh.filter(v=>v.waiting).length}</span></span>
            <span><span style={{ color:"#4a6080" }}>MOVE </span><span style={{ color:"#00e5ff",fontWeight:700 }}>{staticVeh.filter(v=>!v.waiting).length}</span></span>
          </div>
        </div>
        {/* Center */}
        <div style={{ background:"#080c14", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"10px 16px", gap:7, minWidth:86 }}>
          <div style={{ fontSize:9, color:"#4a6080", letterSpacing:"0.15em", textAlign:"center" }}>LIVE<br/>AI GAIN</div>
          <div style={{ fontSize:24, fontWeight:700, lineHeight:1, color:improvement===null?"#4a6080":improvement>0?"#00ff88":improvement<0?"#ff4466":"#ffd700", textShadow:improvement>0?"0 0 14px #00ff8888":"none" }}>
            {improvement===null?"—":improvement>0?`−${improvement}%`:improvement<0?`+${Math.abs(improvement)}%`:"0%"}
          </div>
          {improvement!==null&&(
            <div style={{ padding:"2px 8px",borderRadius:10,fontSize:9,letterSpacing:"0.1em", background:improvement>0?"#00ff8818":"#ff446618", border:`1px solid ${improvement>0?"#00ff8840":"#ff446640"}`, color:improvement>0?"#00ff88":"#ff4466" }}>
              {improvement>0?"BETTER":improvement<0?"WORSE":"EQUAL"}
            </div>
          )}
        </div>
        {/* AI */}
        <div style={{ background:"#0d1117", padding:"16px 20px", borderLeft:"1px solid #1c2a3a" }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
            <div style={{ width:8,height:8,borderRadius:"50%",background:"#00ff88",boxShadow:"0 0 8px #00ff88",animation:"pulse 2s infinite" }} />
            <span style={{ fontSize:10, letterSpacing:"0.2em", color:"#8a9bb0" }}>AI OPTIMIZED</span>
            <span style={{ fontSize:8, padding:"1px 6px", borderRadius:8, background:"#00ff8818", border:"1px solid #00ff8840", color:"#00ff88" }}>LIVE</span>
          </div>
          <div style={{ fontSize:10, color:"#4a6080", marginBottom:3 }}>AVG WAITING TIME</div>
          <div style={{ display:"flex", alignItems:"baseline", gap:8, marginBottom:5 }}>
            <span style={{ fontSize:34, fontWeight:700, color:"#00ff88", textShadow:"0 0 16px #00ff8855", lineHeight:1 }}>{aRolling}</span>
            <span style={{ fontSize:10, color:"#4a6080" }}>ticks/veh</span>
          </div>
          <div style={{ fontSize:9, color:"#4a606088", marginBottom:8 }}>Adaptive: demand-weighted</div>
          <Sparkline data={aiHistory} color="#00ff88" />
          <div style={{ marginTop:8, display:"flex", gap:14, fontSize:9 }}>
            <span><span style={{ color:"#4a6080" }}>NOW </span><span style={{ color:"#00ff88",fontWeight:700 }}>{aiWait.toFixed(2)}</span></span>
            <span><span style={{ color:"#4a6080" }}>WAIT </span><span style={{ color:"#ff4466",fontWeight:700 }}>{aiVeh.filter(v=>v.waiting).length}</span></span>
            <span><span style={{ color:"#4a6080" }}>MOVE </span><span style={{ color:"#00e5ff",fontWeight:700 }}>{aiVeh.filter(v=>!v.waiting).length}</span></span>
          </div>
        </div>
      </div>

      {/* ── TIME-BASED ANALYSIS PANEL ── */}
      <div style={{ width:"100%", maxWidth:760, marginBottom:14, background:"#0d1117", border:"1px solid #ffd70033", borderRadius:10, overflow:"hidden" }}>
        <div style={{ background:"#ffd70008", borderBottom:"1px solid #ffd70022", padding:"10px 20px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div>
            <span style={{ fontSize:11, color:"#ffd700", letterSpacing:"0.2em" }}>⏱ TIMED ANALYSIS</span>
            <span style={{ fontSize:9, color:"#4a6080", marginLeft:12 }}>Fast-forward simulation · Calculate real wait times</span>
          </div>
        </div>

        <div style={{ padding:"16px 20px", display:"flex", alignItems:"flex-end", gap:20, flexWrap:"wrap" }}>
          {/* Duration picker */}
          <div style={{ flex:"1 1 260px" }}>
            <Slider
              label="SIMULATION DURATION"
              value={analysisDuration} min={1} max={60} step={1} unit=" min"
              color="#ffd700"
              onChange={setAnalysisDuration}
            />
            {/* Quick-set duration buttons */}
            <div style={{ display:"flex", gap:6, marginTop:-8 }}>
              {[1,2,5,10,15,30,60].map(v=>(
                <button key={v} onClick={()=>setAnalysisDuration(v)} style={{ background:analysisDuration===v?"#ffd70022":"#0a0e1a", border:`1px solid ${analysisDuration===v?"#ffd700":"#1c2a3a"}`, color:analysisDuration===v?"#ffd700":"#4a6080", borderRadius:4, padding:"3px 8px", fontSize:9, cursor:"pointer", fontFamily:"inherit" }}>{v}m</button>
              ))}
            </div>
          </div>

          {/* Config summary + run button */}
          <div style={{ display:"flex", flexDirection:"column", gap:8, minWidth:200 }}>
            <div style={{ background:"#080c14", border:"1px solid #1c2a3a", borderRadius:6, padding:"8px 12px", fontSize:9, color:"#4a6080" }}>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:4 }}>
                <span>🚗 {appliedVehicles} vehicles</span>
                <span>🚦 {appliedLights} lights</span>
                <span>⏱ {analysisDuration} min run</span>
                <span>📊 {analysisDuration*60*TICKS_PER_SECOND} ticks</span>
              </div>
            </div>
            <button
              onClick={runAnalysis}
              disabled={analysisRunning}
              style={{
                background: analysisRunning?"#1c2a3a":"linear-gradient(90deg,#ffd70022,#ffd70011)",
                border:`1px solid ${analysisRunning?"#1c2a3a":"#ffd700"}`,
                color: analysisRunning?"#4a6080":"#ffd700",
                borderRadius:6, padding:"10px 20px", fontSize:12,
                letterSpacing:"0.1em", cursor:analysisRunning?"not-allowed":"pointer",
                fontFamily:"inherit", fontWeight:700,
                boxShadow: analysisRunning?"none":"0 0 16px #ffd70033",
                transition:"all 0.2s",
              }}
            >
              {analysisRunning ? `⏳ COMPUTING... ${analysisProgress}%` : `▶ RUN ${analysisDuration}-MINUTE ANALYSIS`}
            </button>
          </div>
        </div>

        {/* Progress bar */}
        {analysisRunning && (
          <div style={{ margin:"0 20px 16px", height:4, background:"#1c2a3a", borderRadius:2 }}>
            <div style={{ height:"100%", width:`${analysisProgress}%`, background:"linear-gradient(90deg,#ffd70066,#ffd700)", borderRadius:2, transition:"width 0.1s" }} />
          </div>
        )}
      </div>

      {/* ── Controls ── */}
      <div style={{ display:"flex", gap:8, marginBottom:12, flexWrap:"wrap", justifyContent:"center" }}>
        <button onClick={()=>setRunning(r=>!r)} style={btnStyle(running,"#00ff88")}>{running?"⏸ PAUSE":"▶ RUN"}</button>
        <button onClick={()=>{
          const inter=pickIntersections(appliedLights);
          setStaticVeh(spawnVehicles(appliedVehicles)); setAiVeh(spawnVehicles(appliedVehicles));
          setStaticSigs(makeSignals(inter)); setAiSigs(makeSignals(inter));
          setStaticHistory([]); setAiHistory([]); setTick(0); setReportResult(null);
        }} style={btnStyle(false,"#ffd700")}>🔄 RESET</button>
      </div>

      {/* ── Tabs ── */}
      <div style={{ display:"flex", gap:0, marginBottom:0, borderBottom:"1px solid #1c2a3a", width:"100%", maxWidth:760 }}>
        {[
          ["sim","🗺 SIMULATION"],
          ["heat","🌡 HEATMAP"],
          ["info","📊 INFO"],
          ["report", reportResult?"📋 REPORT ✓":"📋 REPORT"],
        ].map(([id,label])=>(
          <button key={id} onClick={()=>setActiveTab(id)} style={{
            background:"none", border:"none",
            borderBottom: activeTab===id?"2px solid #00e5ff":"2px solid transparent",
            color: activeTab===id?"#00e5ff": id==="report"&&reportResult?"#ffd700":"#4a6080",
            padding:"9px 16px", cursor:"pointer", fontSize:11, letterSpacing:"0.12em", fontFamily:"inherit",
          }}>{label}</button>
        ))}
      </div>

      {/* ── Canvas / tab content ── */}
      <div style={{ width:"100%", maxWidth:760, background:"#0d1117", border:"1px solid #1c2a3a", borderTop:"none", borderRadius:"0 0 8px 8px", display:"flex", flexDirection:"column", alignItems:"center", padding:"14px" }}>

        {(activeTab==="sim"||activeTab==="heat")&&(
          <div style={{ display:"flex", gap:0, marginBottom:10, border:"1px solid #1c2a3a", borderRadius:6, overflow:"hidden" }}>
            {[["static","🔴 STATIC","#ff8c42"],["ai","🟢 AI OPTIMIZED","#00ff88"]].map(([v,label,col])=>(
              <button key={v} onClick={()=>setActiveView(v)} style={{ background:activeView===v?`${col}18`:"transparent", border:"none", borderRight:v==="static"?"1px solid #1c2a3a":"none", color:activeView===v?col:"#4a6080", padding:"6px 18px", cursor:"pointer", fontSize:10, letterSpacing:"0.1em", fontFamily:"inherit" }}>{label}</button>
            ))}
          </div>
        )}

        <canvas ref={canvasRef}  width={W} height={W} style={{ display:activeTab==="sim"?"block":"none",  borderRadius:4 }} />
        <canvas ref={heatmapRef} width={W} height={W} style={{ display:activeTab==="heat"?"block":"none", borderRadius:4 }} />

        {activeTab==="info"&&(
          <div style={{ width:W, padding:4 }}>
            <div style={{ color:"#00e5ff", marginBottom:14, fontSize:12, letterSpacing:"0.1em" }}>SYSTEM DIAGNOSTICS</div>
            <div style={{ marginBottom:16, border:"1px solid #1c2a3a", borderRadius:8, overflow:"hidden" }}>
              <div style={{ display:"grid", gridTemplateColumns:"1.4fr 1fr 1fr", background:"#080c14", padding:"8px 14px", borderBottom:"1px solid #1c2a3a", fontSize:9, color:"#4a6080", letterSpacing:"0.15em" }}>
                <div>METRIC</div><div style={{ color:"#ff8c42" }}>◉ STATIC</div><div style={{ color:"#00ff88" }}>◉ AI OPT</div>
              </div>
              {[
                ["Vehicles",         appliedVehicles,                               appliedVehicles],
                ["Traffic Lights",   appliedLights,                                 appliedLights],
                ["Avg Wait (live)",  `${sRolling} t/v`,                             `${aRolling} t/v`],
                ["Currently Waiting",staticVeh.filter(v=>v.waiting).length,         aiVeh.filter(v=>v.waiting).length],
                ["Currently Moving", staticVeh.filter(v=>!v.waiting).length,        aiVeh.filter(v=>!v.waiting).length],
                ["AI Improvement",   "baseline",                                     improvement!==null?(improvement>0?`−${improvement}%`:`+${Math.abs(improvement)}%`):"—"],
              ].map(([lbl,a,b],i)=>(
                <div key={lbl} style={{ display:"grid", gridTemplateColumns:"1.4fr 1fr 1fr", padding:"7px 14px", background:i%2===0?"transparent":"#0a0d16", fontSize:10, borderBottom:"1px solid #1c2a3a11" }}>
                  <div style={{ color:"#7a92b0" }}>{lbl}</div>
                  <div style={{ color:"#ff8c42" }}>{a}</div>
                  <div style={{ color:"#00ff88" }}>{b}</div>
                </div>
              ))}
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, maxHeight:260, overflowY:"auto" }}>
              {aiSigs.map(s=>{
                const ss=staticSigs.find(x=>x.id===s.id);
                return (
                  <div key={s.id} style={{ background:"#080c14", border:"1px solid #1c2a3a", borderRadius:6, padding:"9px 12px", fontSize:10 }}>
                    <div style={{ color:"#4a6080", marginBottom:4, fontSize:9 }}>INTERSECTION {s.id}</div>
                    <div style={{ color:"#ff8c42", marginBottom:2 }}>Static: NS {ss?.nsGreen}s · EW {ss?.ewGreen}s</div>
                    <div style={{ color:"#00ff88", marginBottom:4 }}>AI: NS {s.nsGreen}s · EW {s.ewGreen}s</div>
                    <div style={{ height:3, background:"#1c2a3a", borderRadius:2 }}>
                      <div style={{ height:"100%", width:`${(aiLoad[s.id]||0)*100}%`, background:`hsl(${120-(aiLoad[s.id]||0)*120},80%,55%)`, borderRadius:2, transition:"width 0.3s" }} />
                    </div>
                    <div style={{ fontSize:9, color:"#4a6080", marginTop:2 }}>LOAD: {((aiLoad[s.id]||0)*100).toFixed(0)}%</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {activeTab==="report"&&(
          <div style={{ width:"100%", maxWidth:W }}>
            {!reportResult && !analysisRunning && (
              <div style={{ textAlign:"center", padding:"40px 20px", color:"#4a6080" }}>
                <div style={{ fontSize:40, marginBottom:12 }}>⏱</div>
                <div style={{ fontSize:13, marginBottom:8, color:"#8a9bb0" }}>No report yet</div>
                <div style={{ fontSize:10 }}>Set your duration above and click<br/><span style={{ color:"#ffd700" }}>▶ RUN X-MINUTE ANALYSIS</span> to generate a full report</div>
              </div>
            )}
            {analysisRunning && (
              <div style={{ textAlign:"center", padding:"40px 20px", color:"#4a6080" }}>
                <div style={{ fontSize:40, marginBottom:12 }}>⚙️</div>
                <div style={{ fontSize:13, color:"#ffd700", marginBottom:8 }}>Running {analysisDuration}-minute analysis...</div>
                <div style={{ width:"60%", height:6, background:"#1c2a3a", borderRadius:3, margin:"0 auto" }}>
                  <div style={{ height:"100%", width:`${analysisProgress}%`, background:"linear-gradient(90deg,#ffd70066,#ffd700)", borderRadius:3, transition:"width 0.2s" }} />
                </div>
                <div style={{ fontSize:10, marginTop:8 }}>{analysisProgress}% complete</div>
              </div>
            )}
            {reportResult && !analysisRunning && (
              <ReportCard result={reportResult} vehicles={appliedVehicles} lights={appliedLights} durationMin={analysisDuration} />
            )}
          </div>
        )}
      </div>

      {activeTab==="sim"&&(
        <div style={{ display:"flex", gap:16, marginTop:10, flexWrap:"wrap", justifyContent:"center", fontSize:9, color:"#4a6080", letterSpacing:"0.1em" }}>
          {[["#00ff88","GREEN"],["#ffd700","YELLOW"],["#ff4466","RED/WAITING"],["#00e5ff","MOVING"]].map(([col,lbl])=>(
            <div key={lbl} style={{ display:"flex", alignItems:"center", gap:5 }}>
              <div style={{ width:7,height:7,borderRadius:"50%",background:col,boxShadow:`0 0 5px ${col}` }} />
              {lbl}
            </div>
          ))}
        </div>
      )}

      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}} input[type=range]::-webkit-slider-thumb{opacity:0}`}</style>
      <div style={{ marginTop:16, fontSize:9, color:"#2a3a4a", letterSpacing:"0.15em" }}>
        NEXUS//TRAFFIC · {appliedVehicles} VEHICLES · {appliedLights} LIGHTS · DUAL ENGINE
      </div>
    </div>
  );
}

function btnStyle(active, color) {
  return {
    background:active?`${color}22`:"#0d1117",
    border:`1px solid ${active?color:"#1c2a3a"}`,
    color:active?color:"#4a6080",
    borderRadius:6, padding:"7px 16px", fontSize:11,
    letterSpacing:"0.1em", cursor:"pointer", transition:"all 0.2s",
    fontFamily:"'Courier New',monospace",
    boxShadow:active?`0 0 12px ${color}44`:"none",
  };
}
