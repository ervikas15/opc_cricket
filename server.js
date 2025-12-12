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

  players: {},
  bowlers: [],

  striker: null,
  nonStriker: null,
  currentBowler: null,

  awaitingNewBatsman: false,
  awaitingNewBowler: false,   // wait for bowler after over
  lastOverBowler: null,       // the bowler who just finished an over
  lastManStandingMode: false,

  battingOrder: [],
  nextBatsmanIndex: 2,

  log: [],
  finalResult: null, // Stores the final match result message
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

function formatOvers(balls) {
  return `${Math.floor(balls / 6)}.${balls % 6}`;
}

/* -------------------------
   MATCH END CHECK
------------------------- */
function checkForMatchEnd(res) {
  if (state.innings !== 2) return false;

  if (state.score >= state.target) {
    const wicketsLeft = Math.max(
      0,
      Object.keys(state.players).length - state.wickets
    );
    const msg = `${
      state.teams[state.battingTeam].name
    } WIN by ${wicketsLeft} wickets!`;
    log(msg);
    state.matchStarted = false;
    state.finalResult = msg; // STORED
    res.json({ message: "Match ended", finalResult: msg, state });
    return true;
  }

  if (
    state.innings1Score.balls > 0 &&
    state.balls >= state.innings1Score.balls &&
    state.score < state.target
  ) {
    const runsDiff = state.target - 1 - state.score;
    const msg = `${
      state.teams[state.bowlingTeam].name
    } WIN by ${runsDiff} runs!`;
    log(msg);
    state.matchStarted = false;
    state.finalResult = msg; // STORED
    res.json({
      message: "Match ended (overs complete)",
      finalResult: msg,
      state,
    });
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
    finalResult: state.finalResult, // RETURNED
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
  state.innings1Score = {
    score: 0,
    wickets: 0,
    balls: 0,
    battingTeam: null,
  };
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
  state.finalResult = null; // Also clear here for consistency

  log(
    `Teams created: ${state.teams.teamA.name} vs ${state.teams.teamB.name}`
  );

  res.json({ message: "Teams created", state });
});

/* -------------------------
   SET TEAMS & START INNINGS
------------------------- */
app.post("/api/setTeamsAndMatch", (req, res) => {
  const { battingTeam, openingStriker, openingNonStriker, startingBowler } =
    req.body;

  if (
    !battingTeam ||
    !openingStriker ||
    !openingNonStriker ||
    !startingBowler
  ) {
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
  state.finalResult = null; // Clear if starting a new innings/match

  log(
    `Innings ${state.innings} started. ${state.teams[state.battingTeam].name} batting.`
  );

  res.json({ message: "Innings started", state });
});

/* -------------------------
   END INNINGS (1 → 2)
------------------------- */
app.post("/api/endInnings", (req, res) => {
  if (state.innings !== 1)
    return res.status(400).json({ message: "Can only end innings 1" });

  state.innings1Score = {
    score: state.score,
    wickets: state.wickets,
    balls: state.balls,
    battingTeam: state.battingTeam,
  };

  state.target = state.score + 1;
  state.innings = 2;

  state.matchStarted = false;

  const newBat = state.bowlingTeam;
  const newBowl = state.battingTeam;

  state.battingTeam = newBat;
  state.bowlingTeam = newBowl;

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
  state.finalResult = null; // Clear if we manually end innings 1

  log(
    `Innings 1 ended. Target for ${state.teams[state.battingTeam].name}: ${state.target}`
  );

  res.json({
    message: "Innings 1 ended. Setup innings 2",
    state,
  });
});

/* -------------------------
   RECORD RUN
------------------------- */
app.post("/api/run/:value", (req, res) => {
  if (!state.matchStarted)
    return res.status(400).json({ message: "Match not started" });

  if (state.awaitingNewBatsman)
    return res
      .status(400)
      .json({ message: "Awaiting new batsman selection" });

  if (state.awaitingNewBowler)
    return res
      .status(400)
      .json({ message: "Awaiting next bowler selection" });

  const runs = parseInt(req.params.value);
  if (isNaN(runs) || runs < 0)
    return res.status(400).json({ message: "Invalid runs" });

  if (!state.striker || !state.currentBowler)
    return res
      .status(400)
      .json({ message: "Striker/bowler not set" });

  const bat = ensurePlayerExists(state.striker);
  const bow = ensureBowlerExists(state.currentBowler);

  bat.runs += runs;
  bat.ballsFaced += 1;

  if (runs === 4) bat.fours++;
  if (runs === 6) bat.sixes++;

  bow.totalBalls++;
  bow.runsConceded += runs;

  state.score += runs;
  state.balls++;

  log(`${state.striker} scored ${runs}`);

  // odd run = rotate strike
  if (runs % 2 === 1) {
    if (!state.lastManStandingMode) { // <--- Last Man Standing check
      [state.striker, state.nonStriker] = [
        state.nonStriker,
        state.striker,
      ];
      log("Strike rotated (odd runs)");
    } else {
      log("Strike not rotated (Last Man Standing)");
    }
  }

  // end of over
  if (state.balls % 6 === 0) {
    // rotate strike
    if (!state.lastManStandingMode) { // <--- Last Man Standing check
      [state.striker, state.nonStriker] = [
        state.nonStriker,
        state.striker,
      ];
    }

    state.lastOverBowler = state.currentBowler;
    state.awaitingNewBowler = true;

    log(
      `End of over ${formatOvers(
        state.balls
      )} – awaiting next bowler`
    );
  }

  if (checkForMatchEnd(res)) return;

  res.json({ message: "Run updated", state });
});

/* -------------------------
   WICKET
------------------------- */
app.post("/api/wicket", (req, res) => {
  if (!state.matchStarted)
    return res.status(400).json({ message: "Match not started" });

  if (state.awaitingNewBatsman)
    return res
      .status(400)
      .json({ message: "Already awaiting new batsman" });

  if (state.awaitingNewBowler)
    return res
      .status(400)
      .json({ message: "Awaiting next bowler selection" });

  const { wicketType } = req.body;

  if (!wicketType)
    return res
      .status(400)
      .json({ message: "wicketType required" });

  const bat = ensurePlayerExists(state.striker);
  const bow = ensureBowlerExists(state.currentBowler);

  bat.out = true;
  bat.outReason = wicketType;
  bat.ballsFaced++;

  bow.totalBalls++;
  bow.wickets++;

  state.wickets++;
  state.balls++;

  log(`${bat.name} OUT (${wicketType})`);

  // last-man case
  if (state.lastManStandingMode) {
    state.striker = null;
    state.matchStarted = false; // Stop scoring immediately

    // IF INNINGS 1: Transition to Innings 2 setup
    if (state.innings === 1) {
        state.innings1Score = {
            score: state.score,
            wickets: state.wickets,
            balls: state.balls,
            battingTeam: state.battingTeam,
        };

        state.target = state.score + 1;
        state.innings = 2;

        const newBat = state.bowlingTeam;
        const newBowl = state.battingTeam;

        state.battingTeam = newBat;
        state.bowlingTeam = newBowl;

        state.score = 0;
        state.wickets = 0;
        state.balls = 0;

        state.nonStriker = null;
        state.currentBowler = null;

        state.bowlers = [];
        state.awaitingNewBatsman = false;
        state.awaitingNewBowler = false;
        state.lastOverBowler = null;
        state.lastManStandingMode = false;
        
        log(
          `Innings 1 ended (Last Man Out). Target for ${state.teams[state.battingTeam].name}: ${state.target}`
        );
        
        return res.json({
          message: "Last man out. Innings 1 ended. Setup innings 2.",
          state,
        });
    }

    // IF INNINGS 2: Match is over
    const runsToWin = state.target - 1;
    const isWin = state.score >= state.target;
    let msg = "Match ended";
    if (isWin) {
      const wicketsLeft = Math.max(0, Object.keys(state.players).length - state.wickets);
      msg = `${state.teams[state.battingTeam].name} WIN by ${wicketsLeft} wickets!`;
    } else {
      const runsDiff = runsToWin - state.score;
      msg = `${state.teams[state.bowlingTeam].name} WIN by ${runsDiff} runs!`;
    }

    state.finalResult = msg; // STORED when match ends via last man out in Innings 2

    return res.json({
      message: "Last man out. Match ended",
      finalResult: msg,
      state,
    });
  }

  // ask for new batsman
  state.awaitingNewBatsman = true;
  state.striker = null;

  // over ended?
  if (state.balls % 6 === 0) {
    state.awaitingNewBowler = true;
    state.lastOverBowler = state.currentBowler;
  }

  res.json({
    message: "Wicket recorded",
    awaitingNewBatsman: true,
    state,
  });
});

/* -------------------------
   NEW BATSMAN
------------------------- */
app.post("/api/newBatsman", (req, res) => {
  if (!state.awaitingNewBatsman)
    return res
      .status(400)
      .json({ message: "Not awaiting new batsman" });

  const { name } = req.body;

  ensurePlayerExists(name);
  state.striker = name;
  state.awaitingNewBatsman = false;

  state.battingOrder.push(name);

  log(`New batsman: ${name}`);

  res.json({ message: "New batsman added", state });
});

/* -------------------------
   LAST MAN STANDING
------------------------- */
app.post("/api/lastManStanding", (req, res) => {
  const { useLastMan } = req.body;

  if (!state.awaitingNewBatsman)
    return res
      .status(400)
      .json({ message: "Not awaiting new batsman" });

  if (!useLastMan)
    return res
      .status(400)
      .json({ message: "useLastMan must be true" });

  if (!state.nonStriker)
    return res
      .status(400)
      .json({ message: "No survivor to continue" });

  state.lastManStandingMode = true;
  state.striker = state.nonStriker;
  state.nonStriker = null;

  state.awaitingNewBatsman = false;

  log(`Last man standing activated`);

  res.json({ message: "OK", state });
});

/* -------------------------
   EXTRAS (wide / noball)
------------------------- */
app.post("/api/extras", (req, res) => {
  if (!state.matchStarted)
    return res.status(400).json({ message: "Match not started" });

  if (state.awaitingNewBatsman)
    return res
      .status(400)
      .json({ message: "Awaiting new batsman" });

  if (state.awaitingNewBowler)
    return res
      .status(400)
      .json({ message: "Awaiting next bowler" });

  const { type, extraRuns } = req.body;

  if (!type || (type !== "wide" && type !== "noball"))
    return res
      .status(400)
      .json({ message: "Invalid extra type" });

  const extra = parseInt(extraRuns) || 0;

  // base +1 always
  state.score++;
  if (state.currentBowler)
    ensureBowlerExists(state.currentBowler).runsConceded++;

  if (type === "noball") {
    // extra runs to batsman
    if (state.striker)
      ensurePlayerExists(state.striker).runs += extra;

    if (state.currentBowler)
      ensureBowlerExists(state.currentBowler).runsConceded += extra;

    state.score += extra;

    log(`No-ball +${extra}`);
  } else {
    // wide = extras only
    if (state.currentBowler)
      ensureBowlerExists(state.currentBowler).runsConceded += extra;

    state.score += extra;

    log(`Wide +${extra}`);
  }

  // Check for match end after runs are added (only relevant for Innings 2)
  if (checkForMatchEnd(res)) return;

  res.json({ message: "Extras recorded", state });
});

/* -------------------------
   SELECT BOWLER (patched)
------------------------- */
app.post("/api/selectBowler", (req, res) => {
  const { bowler } = req.body;

  if (!bowler)
    return res.json({
      success: false,
      error: "No bowler provided",
      state,
    });

  const wasSame =
    state.lastOverBowler &&
    state.lastOverBowler === bowler;

  ensureBowlerExists(bowler);
  state.currentBowler = bowler;

  if (state.awaitingNewBowler) {
    state.awaitingNewBowler = false;
    state.lastOverBowler = null;
    state.matchStarted = true;

    log(`Next bowler selected: ${bowler}`);

    return res.json({
      success: true,
      resumed: true,
      warningSame: wasSame,
      state,
    });
  }

  log(`Bowler changed to ${bowler}`);

  return res.json({
    success: true,
    resumed: false,
    warningSame: wasSame,
    state,
  });
});

/* -------------------------
   CHANGE STRIKE (swap or set)
------------------------- */
app.post("/api/changeStrike", (req, res) => {
  const { action, name } = req.body || {};

  if (!state.matchStarted)
    return res
      .status(400)
      .json({ message: "Match not started" });

  if (action === "swap") {
    if (state.lastManStandingMode)
      return res.status(400).json({ message: "Cannot swap strike in Last Man Standing mode" });
      
    [state.striker, state.nonStriker] = [
      state.nonStriker,
      state.striker,
    ];
    log("Strike swapped manually");
    return res.json({ message: "Strike swapped", state });
  }

  // Logic for setting the Striker
  if (action === "set_striker") { // Changed from 'set' to 'set_striker'
    if (!name)
      return res
        .status(400)
        .json({ message: "Name required" });

    // 1. Ensure the player object exists in state.players (creates it if needed)
    ensurePlayerExists(name); 

    if (state.nonStriker === name && !state.lastManStandingMode) {
      // If the selected player is the non-striker, just swap them.
      [state.striker, state.nonStriker] = [
        state.nonStriker,
        state.striker,
      ];
      log(`Strike set to ${name} (was non-striker)`);
    } else if (state.striker !== name) {
      // If the selected player is neither the striker nor non-striker, 
      // the current striker becomes the non-striker, and the selected player becomes the striker.
      if (!state.lastManStandingMode) {
        state.nonStriker = state.striker;
      } else {
        // In L.M.S. mode, nonStriker is null
        state.nonStriker = null;
      }
      state.striker = name;
      log(`Strike changed - new striker: ${name} (forced)`);
    }
    // If state.striker === name, no change is needed.

    return res.json({
      message: "Striker changed (forced)",
      state,
    });
  }
  
  // New logic for setting the Non-Striker
  if (action === "set_non_striker") {
      if (!name)
          return res.status(400).json({ message: "Name required" });
          
      // Cannot set non-striker if in Last Man Standing mode
      if (state.lastManStandingMode)
          return res.status(400).json({ message: "Cannot set non-striker in Last Man Standing mode" });
          
      // Ensure the player object exists in state.players (creates it if needed)
      ensurePlayerExists(name); 

      // Prevent setting a player who is already the striker
      if (state.striker === name) {
          return res.status(400).json({ message: `${name} is already the striker.` });
      }
      
      // Prevent setting the same non-striker
      if (state.nonStriker === name) {
          return res.json({ message: "Non-Striker is already set to that player.", state });
      }

      state.nonStriker = name;
      log(`Non-Striker changed to: ${name}`);

      return res.json({
          message: "Non-Striker changed (forced)",
          state,
      });
  }


  return res
    .status(400)
    .json({ message: "Invalid action" });
});

/* -------------------------
   RESET
------------------------- */
app.post("/api/reset", (req, res) => {
  state = {
    matchStarted: false,
    teams: {
      teamA: { name: "Team A" },
      teamB: { name: "Team B" },
    },
    innings: 1,
    innings1Score: {
      score: 0,
      wickets: 0,
      balls: 0,
      battingTeam: null,
    },
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
    finalResult: null, // CLEARED
  };

  res.json({ message: "Reset done", state });
});

/* STATIC FILE SERVING */
app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);