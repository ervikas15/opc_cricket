const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);
app.use(express.json());

/* -------------------------
   GLOBAL STATE
------------------------- */
let state = {
  matchStarted: false,

  teams: {
    teamA: { name: "Team A" },
    teamB: { name: "Team B" },
  },

  innings: 1,
  innings1Score: { score: 0, wickets: 0, balls: 0, battingTeam: null },
  target: 0,

  battingTeam: null,
  bowlingTeam: null,

  score: 0,
  wickets: 0,
  balls: 0,

  players: {},     // { name: {name, runs, ballsFaced, fours, sixes, out, outReason } }
  bowlers: [],     // [{name, totalBalls, runsConceded, wickets}]

  striker: null,
  nonStriker: null,
  currentBowler: null,

  awaitingNewBatsman: false,
  awaitingNewBowler: false,   // NEW: wait for bowler after over
  lastOverBowler: null,       // the bowler who just finished an over
  lastManStandingMode: false,

  battingOrder: [],
  nextBatsmanIndex: 2,

  log: [],
};

function log(msg) {
  state.log.push(`${new Date().toLocaleTimeString()} - ${msg}`);
}

/* -------------------------
   HELPERS
------------------------- */
function ensurePlayerExists(name) {
  if (!name) return null;
  if (!state.players[name]) {
    state.players[name] = {
      name,
      runs: 0,
      ballsFaced: 0,
      fours: 0,
      sixes: 0,
      out: false,
      outReason: null,
    };
  }
  return state.players[name];
}

function ensureBowlerExists(name) {
  if (!name) return null;
  let b = state.bowlers.find((x) => x.name === name);
  if (!b) {
    b = { name, totalBalls: 0, runsConceded: 0, wickets: 0 };
    state.bowlers.push(b);
  }
  return b;
}

function formatOversFromBalls(balls) {
  return `${Math.floor(balls / 6)}.${balls % 6}`;
}

/* -------------------------
   MATCH END CHECK
------------------------- */
function checkForMatchEnd(res) {
  if (state.innings !== 2) return false;

  if (state.score >= state.target) {
    const wicketsLeft = Math.max(0, Object.keys(state.players).length - state.wickets);
    const msg = `${state.teams[state.battingTeam].name} WIN by ${wicketsLeft} wickets!`;
    log(msg);
    state.matchStarted = false;
    res.json({ message: "Match ended", finalResult: msg, state });
    return true;
  }

  if (
    state.innings1Score.balls > 0 &&
    state.balls >= state.innings1Score.balls &&
    state.score < state.target
  ) {
    const runsDiff = state.target - 1 - state.score;
    const msg = `${state.teams[state.bowlingTeam].name} WIN by ${runsDiff} runs!`;
    log(msg);
    state.matchStarted = false;
    res.json({ message: "Match ended (overs complete)", finalResult: msg, state });
    return true;
  }

  return false;
}

/* -------------------------
   GET SCORE
------------------------- */
app.get("/api/score", (req, res) => {
  res.json({
    innings: state.innings,
    innings1Score: state.innings1Score,
    target: state.target,

    battingTeam: state.battingTeam,
    bowlingTeam: state.bowlingTeam,

    score: state.score,
    wickets: state.wickets,
    balls: state.balls,
    striker: state.striker,
    nonStriker: state.nonStriker,
    currentBowler: state.currentBowler,

    players: Object.values(state.players),
    bowlers: state.bowlers,

    awaitingNewBatsman: state.awaitingNewBatsman,
    awaitingNewBowler: state.awaitingNewBowler,
    lastOverBowler: state.lastOverBowler,
    lastManStandingMode: state.lastManStandingMode,
    matchStarted: state.matchStarted,
    teams: state.teams,
    log: state.log,
  });
});

/* -------------------------
   CREATE TEAMS
------------------------- */
app.post("/api/createTeams", (req, res) => {
  const { teamA, teamB } = req.body;
  state.teams.teamA.name = (teamA && teamA.name) || "Team A";
  state.teams.teamB.name = (teamB && teamB.name) || "Team B";

  // Reset match
  state.innings = 1;
  state.innings1Score = { score: 0, wickets: 0, balls: 0, battingTeam: null };
  state.target = 0;

  state.battingTeam = null;
  state.bowlingTeam = null;

  state.score = 0;
  state.wickets = 0;
  state.balls = 0;

  state.players = {};
  state.bowlers = [];

  state.striker = null;
  state.nonStriker = null;
  state.currentBowler = null;

  state.awaitingNewBatsman = false;
  state.awaitingNewBowler = false;
  state.lastOverBowler = null;
  state.lastManStandingMode = false;

  state.battingOrder = [];
  state.nextBatsmanIndex = 2;

  state.log = [];

  log(`Teams created: ${state.teams.teamA.name} vs ${state.teams.teamB.name}`);
  res.json({ message: "Teams created", state });
});

/* -------------------------
   SET TEAMS & START INNINGS
------------------------- */
app.post("/api/setTeamsAndMatch", (req, res) => {
  const { battingTeam, openingStriker, openingNonStriker, startingBowler } = req.body;
  if (!battingTeam || !openingStriker || !openingNonStriker || !startingBowler) {
    return res.status(400).json({ message: "Missing parameters" });
  }

  state.battingTeam = battingTeam;
  state.bowlingTeam = battingTeam === "teamA" ? "teamB" : "teamA";

  ensurePlayerExists(openingStriker);
  ensurePlayerExists(openingNonStriker);
  ensureBowlerExists(startingBowler);

  state.striker = openingStriker;
  state.nonStriker = openingNonStriker;
  state.currentBowler = startingBowler;

  state.battingOrder = [openingStriker, openingNonStriker];
  state.nextBatsmanIndex = 2;

  state.awaitingNewBatsman = false;
  state.awaitingNewBowler = false;
  state.lastManStandingMode = false;

  state.matchStarted = true;

  log(`Innings ${state.innings} started. ${state.teams[state.battingTeam].name} batting.`);
  res.json({ message: "Innings started", state });
});

/* -------------------------
   END INNINGS (1 -> 2)
------------------------- */
app.post("/api/endInnings", (req, res) => {
  if (state.innings !== 1) return res.status(400).json({ message: "Can only end innings 1" });

  state.innings1Score.score = state.score;
  state.innings1Score.wickets = state.wickets;
  state.innings1Score.balls = state.balls;
  state.innings1Score.battingTeam = state.battingTeam;

  state.target = state.score + 1;
  state.innings = 2;
  state.matchStarted = false;

  // swap sides
  const newBatting = state.bowlingTeam;
  const newBowling = state.battingTeam;
  state.battingTeam = newBatting;
  state.bowlingTeam = newBowling;

  // reset inning counters
  state.score = 0;
  state.wickets = 0;
  state.balls = 0;

  state.striker = null;
  state.nonStriker = null;
  state.currentBowler = null;

  state.bowlers = [];
  state.awaitingNewBatsman = false;
  state.awaitingNewBowler = false;
  state.lastOverBowler = null;
  state.lastManStandingMode = false;

  log(`Innings 1 ended. Target for ${state.teams[state.battingTeam].name}: ${state.target}`);
  res.json({ message: "Innings 1 ended. Setup innings 2", state });
});

/* -------------------------
   RECORD RUN (legal)
------------------------- */
app.post("/api/run/:value", (req, res) => {
  if (!state.matchStarted) return res.status(400).json({ message: "Match not started" });
  if (state.awaitingNewBatsman) return res.status(400).json({ message: "Awaiting new batsman selection" });
  if (state.awaitingNewBowler) return res.status(400).json({ message: "Awaiting next bowler selection" });

  const runs = parseInt(req.params.value);
  if (isNaN(runs) || runs < 0) return res.status(400).json({ message: "Invalid runs" });
  if (!state.striker || !state.currentBowler) return res.status(400).json({ message: "Striker/bowler not set" });

  const batsman = ensurePlayerExists(state.striker);
  const bowler = ensureBowlerExists(state.currentBowler);

  batsman.runs += runs;
  batsman.ballsFaced += 1;
  if (runs === 4) batsman.fours++;
  if (runs === 6) batsman.sixes++;

  bowler.totalBalls += 1;
  bowler.runsConceded += runs;

  state.score += runs;
  state.balls += 1;

  log(`${state.striker} scored ${runs}`);

  // rotate strike on odd
  if (runs % 2 === 1) {
    [state.striker, state.nonStriker] = [state.nonStriker, state.striker];
    log("Strike rotated (odd runs)");
  }

  // over completed?
  if (state.balls % 6 === 0) {
    // end of over rotation
    [state.striker, state.nonStriker] = [state.nonStriker, state.striker];
    log(`End of over ${formatOversFromBalls(state.balls)} - strike rotated`);

    // prepare to ask for next bowler (allow same bowler but warn) - pause match
    state.lastOverBowler = state.currentBowler;
    state.awaitingNewBowler = true;
    state.matchStarted = false;
    log("Awaiting next bowler selection after over");
  }

  if (checkForMatchEnd(res)) return;

  res.json({ message: "Run recorded", state });
});

/* -------------------------
   WICKET (accepts wicketType)
   body: { wicketType: "Bowled" | ... , optional: note }
------------------------- */
app.post("/api/wicket", (req, res) => {
  if (!state.matchStarted) return res.status(400).json({ message: "Match not started" });
  if (state.awaitingNewBatsman) return res.status(400).json({ message: "Already awaiting new batsman" });
  if (state.awaitingNewBowler) return res.status(400).json({ message: "Awaiting next bowler selection" });

  const { wicketType } = req.body || {};
  if (!wicketType) return res.status(400).json({ message: "wicketType required" });
  if (!state.striker || !state.currentBowler) return res.status(400).json({ message: "Striker/bowler not set" });

  const batsman = ensurePlayerExists(state.striker);
  const bowler = ensureBowlerExists(state.currentBowler);

  batsman.out = true;
  batsman.ballsFaced += 1;
  batsman.outReason = wicketType;

  bowler.totalBalls += 1;
  bowler.wickets += 1;

  state.wickets++;
  state.balls++;

  log(`${batsman.name} OUT (${wicketType}) - bowler: ${state.currentBowler}`);

  // if last man standing active -> innings ends
  if (state.lastManStandingMode) {
    state.striker = null;
    state.matchStarted = false;
    return res.json({ message: "Last man also out. Innings ended.", state });
  }

  // otherwise pause and ask for new batsman or last-man choice
  state.awaitingNewBatsman = true;
  state.striker = null;

  // if over completed due to wicket (balls%6 === 0), also require next bowler selection
  if (state.balls % 6 === 0) {
    state.lastOverBowler = state.currentBowler;
    state.awaitingNewBowler = true;
    state.matchStarted = false;
    log("Over ended on wicket — awaiting next bowler as well");
  }

  res.json({ message: "Wicket recorded - awaiting new batsman", awaitingNewBatsman: true, state });
});

/* -------------------------
   NEW BATSMAN
   body: { name }
------------------------- */
app.post("/api/newBatsman", (req, res) => {
  const { name } = req.body;
  if (!state.awaitingNewBatsman) return res.status(400).json({ message: "Not awaiting new batsman" });
  if (!name) return res.status(400).json({ message: "No batsman name provided" });

  ensurePlayerExists(name);
  state.striker = name;
  state.awaitingNewBatsman = false;
  state.battingOrder.push(name);

  log(`New batsman: ${name}`);
  res.json({ message: "New batsman added", state });
});

/* -------------------------
   LAST MAN STANDING
   body: { useLastMan: true }
------------------------- */
app.post("/api/lastManStanding", (req, res) => {
  const { useLastMan } = req.body;
  if (!state.awaitingNewBatsman) return res.status(400).json({ message: "Not awaiting new batsman" });

  if (useLastMan) {
    if (!state.nonStriker) return res.status(400).json({ message: "No surviving batsman to continue" });
    state.lastManStandingMode = true;
    state.striker = state.nonStriker;
    state.nonStriker = null;
    state.awaitingNewBatsman = false;
    log(`Last Man Standing activated — ${state.striker} continues alone.`);
    return res.json({ message: "Last man standing activated", state });
  }
  return res.status(400).json({ message: "useLastMan must be true" });
});

/* -------------------------
   EXTRAS (Option A)
   body: { type: "wide"|"noball", runs }
------------------------- */
app.post("/api/extras", (req, res) => {
  if (!state.matchStarted) return res.status(400).json({ message: "Match not started" });
  if (state.awaitingNewBatsman) return res.status(400).json({ message: "Awaiting new batsman" });
  if (state.awaitingNewBowler) return res.status(400).json({ message: "Awaiting next bowler selection" });

  const { type, runs } = req.body;
  if (!type || (type !== "wide" && type !== "noball")) return res.status(400).json({ message: "Invalid extra type" });

  const extraRuns = parseInt(runs) || 0;
  const base = 1;

  state.score += base;
  if (state.currentBowler) {
    const bow = ensureBowlerExists(state.currentBowler);
    bow.runsConceded += base;
  }

  if (type === "noball") {
    // Option A: additional runs go to batsman
    if (state.striker) {
      const bat = ensurePlayerExists(state.striker);
      bat.runs += extraRuns;
    }
    if (state.currentBowler) {
      const bow = ensureBowlerExists(state.currentBowler);
      bow.runsConceded += extraRuns;
    }
    state.score += extraRuns;
    log(`No-ball +${extraRuns} (batsman awarded ${extraRuns})`);
  } else {
    // wide: extra runs are team extras, bowler is charged
    if (state.currentBowler) {
      const bow = ensureBowlerExists(state.currentBowler);
      bow.runsConceded += extraRuns;
    }
    state.score += extraRuns;
    log(`Wide +${extraRuns}`);
  }

  // extras do NOT count as legal balls -> do not increment state.balls

  if (checkForMatchEnd(res)) return;
  res.json({ message: "Extra recorded", state });
});

/* -------------------------
   SELECT BOWLER
   body: { bowler }
   If awaitingNewBowler true, selecting a bowler resumes match.
   Per choice 1:C: allow same bowler but return a warning flag when selected same as lastOverBowler.
------------------------- */
app.post("/api/selectBowler", (req, res) => {
  const { bowler } = req.body;
  if (!bowler) return res.status(400).json({ message: "No bowler provided" });

  const wasSame = state.lastOverBowler && state.lastOverBowler === bowler;
  ensureBowlerExists(bowler);
  state.currentBowler = bowler;

  if (state.awaitingNewBowler) {
    state.awaitingNewBowler = false;
    state.matchStarted = true;
    state.lastOverBowler = null; // reset after accepting
    log(`Next bowler selected: ${bowler} (resumed match)`);
    return res.json({ message: "Bowler selected and match resumed", warningSame: wasSame, state });
  } else {
    log(`Bowler changed to ${bowler}`);
    return res.json({ message: "Bowler selected", warningSame: wasSame, state });
  }
});

/* -------------------------
   CHANGE BOWLER (alias)
------------------------- */
app.post("/api/changeBowler", (req, res) => {
  const { bowler } = req.body;
  if (!bowler) return res.status(400).json({ message: "No bowler provided" });
  ensureBowlerExists(bowler);
  state.currentBowler = bowler;
  log(`Bowler changed to ${bowler}`);
  res.json({ message: "Bowler changed", state });
});

/* -------------------------
   RESET MATCH
------------------------- */
app.post("/api/reset", (req, res) => {
  state = {
    matchStarted: false,
    teams: { teamA: { name: "Team A" }, teamB: { name: "Team B" } },
    innings: 1,
    innings1Score: { score: 0, wickets: 0, balls: 0, battingTeam: null },
    target: 0,
    battingTeam: null,
    bowlingTeam: null,
    score: 0,
    wickets: 0,
    balls: 0,
    players: {},
    bowlers: [],
    striker: null,
    nonStriker: null,
    currentBowler: null,
    awaitingNewBatsman: false,
    awaitingNewBowler: false,
    lastOverBowler: null,
    lastManStandingMode: false,
    battingOrder: [],
    nextBatsmanIndex: 2,
    log: [],
  };
  res.json({ message: "Reset done", state });
});

/* STATIC */
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));