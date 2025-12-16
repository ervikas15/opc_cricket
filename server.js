const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs"); 

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
   PLAYER LIST LOADER
------------------------- */
let allPlayerNames = [];

function loadPlayers() {
  try {
    const playersPath = path.join(__dirname, "public", "players.json");
    if (!fs.existsSync(playersPath)) {
        // Fallback to in-memory if not found in expected path
        const fallbackPlayersPath = path.join(__dirname, "players.json");
        if (fs.existsSync(fallbackPlayersPath)) {
            const data = fs.readFileSync(fallbackPlayersPath, "utf-8");
            allPlayerNames = JSON.parse(data).players;
        } else {
             console.warn("players.json not found. Player list will be empty.");
        }
    } else {
        const data = fs.readFileSync(playersPath, "utf-8");
        allPlayerNames = JSON.parse(data).players;
    }
    console.log(`Loaded ${allPlayerNames.length} players.`);
  } catch (e) {
    console.error("Error loading players.json:", e.message);
    allPlayerNames = [];
  }
}
loadPlayers();


/* -------------------------
   GLOBAL STATE
------------------------- */
let state = {
  matchStarted: false,
  setupPhase: 1, // 1=Teams, 2=XI Selection (now skipped), 3=Innings Setup, 4=Live
  
  teams: {
    teamA: { name: "Team A" },
    teamB: { name: "Team B" },
  },

  innings: 1,
  innings1Score: { score: 0, wickets: 0, balls: 0, battingTeam: null },
  target: 0,
  matchBallLimit: 0, // 0 means no over limit (open overs)
  finalResult: null, // Store the final result message

  battingTeam: null,
  bowlingTeam: null,

  score: 0,
  wickets: 0,
  balls: 0,

  players: {}, // Individual player stats (Player Name -> Stats Object)
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
  
  // Store the list of all available players and the XI (which is now the full list)
  allPlayerNames: allPlayerNames,
  playerLists: { teamA: [], teamB: [] }, 

  log: [],
  stateHistory: [], // for undo functionality
  fallOfWickets: [], // ADDED FOR SCORECARD
};

/* -------------------------
   HELPERS
------------------------- */
const MAX_HISTORY = 10;
function takeSnapshot() {
  // Simple deep copy of the state for rollback
  const snapshot = JSON.parse(JSON.stringify(state)); 
  // Don't save the current history in the snapshot to avoid infinite growth
  snapshot.stateHistory = []; 
  
  state.stateHistory.push(snapshot);
  
  // Keep history limited in size
  if (state.stateHistory.length > MAX_HISTORY) {
      state.stateHistory.shift(); 
  }
}

function log(msg) {
  state.log.push(`${new Date().toLocaleTimeString()} - ${msg}`);
}

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
    b = { name, totalBalls: 0, runsConceded: 0, wickets: 0, maidens: 0 };
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

  const totalPlayers = state.playerLists[state.battingTeam].length;
  // All out is when totalPlayers wickets have fallen.
  const allOut = state.wickets >= totalPlayers; 
  
  const isMatchLimitReached = state.matchBallLimit > 0 && state.balls >= state.matchBallLimit;

  // 1. Win by Wickets (Target Chased)
  if (state.score >= state.target) {
    const wicketsLeft = totalPlayers - state.wickets; 
    const msg = `${
      state.teams[state.battingTeam].name
    } WIN by ${wicketsLeft} wickets!`;
    log(msg);
    state.matchStarted = false;
    state.setupPhase = 5; // Match finished
    state.finalResult = msg; // Store result in state
    res.json({ message: "Match ended (target chased)", finalResult: msg, state });
    return true;
  }
  
  // 2. Win by Runs (Overs Complete or All Out)
  if (isMatchLimitReached || allOut) {
    // If runs not enough, bowling team wins
    if (state.score < state.target) {
        const runsDiff = state.target - 1 - state.score;
        
        let reason = "";
        if (isMatchLimitReached && allOut) reason = "All Out and Overs Complete";
        else if (isMatchLimitReached) reason = "Overs Complete";
        else reason = "All Out";

        const msg = `${
          state.teams[state.bowlingTeam].name
        } WIN by ${runsDiff} runs! (${reason})`; 
        
        log(msg);
        state.matchStarted = false;
        state.setupPhase = 5; // Match finished
        state.finalResult = msg; // Store result in state
        res.json({
          message: `Match ended (${reason.toLowerCase()})`,
          finalResult: msg,
          state,
        });
        return true;
    }
    // The case where allOut is true but score >= target is handled by case 1.
  }

  return false;
}

/* -------------------------
   GET SCORE
------------------------- */
app.get("/api/score", (req, res) => {
  res.json({
    setupPhase: state.setupPhase,
    allPlayerNames: state.allPlayerNames,
    playerLists: state.playerLists,

    innings: state.innings,
    innings1Score: state.innings1Score,
    target: state.target,
    matchBallLimit: state.matchBallLimit, 
    finalResult: state.finalResult,

    battingTeam: state.battingTeam,
    bowlingTeam: state.bowlingTeam,

    score: state.score,
    wickets: state.wickets,
    balls: state.balls,
    striker: state.striker,
    nonStriker: state.nonStriker,
    currentBowler: state.currentBowler,

    players: state.players, 
    bowlers: state.bowlers,
    stateHistoryLength: state.stateHistory.length, 
    
    battingOrder: state.battingOrder, // EXPOSED
    fallOfWickets: state.fallOfWickets, // EXPOSED

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
   CREATE TEAMS (Phase 1 -> 3)
------------------------- */
app.post("/api/createTeams", (req, res) => {
  takeSnapshot(); // SNAPSHOT
  
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
  state.matchBallLimit = 0;
  state.finalResult = null;

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

  state.battingOrder = []; // RESET
  state.nextBatsmanIndex = 2;
  
  state.fallOfWickets = []; // RESET

  state.log = [];
  
  // Skip to Innings Setup phase (Phase 3)
  state.setupPhase = 3; 

  // Populate playerLists with ALL available players (simplified XI)
  state.allPlayerNames = allPlayerNames.sort();
  state.playerLists.teamA = [...state.allPlayerNames];
  state.playerLists.teamB = [...state.allPlayerNames];


  log(
    `Teams created: ${state.teams.teamA.name} vs ${state.teams.teamB.name}`
  );

  res.json({ message: "Teams created", state });
});

/* -------------------------
   SET TEAMS & START INNINGS (Phase 3 -> 4)
------------------------- */
app.post("/api/setTeamsAndMatch", (req, res) => {
  const { battingTeam, openingStriker, openingNonStriker, startingBowler, matchOvers } = 
    req.body;

  if (
    !battingTeam ||
    !openingStriker ||
    !openingNonStriker ||
    !startingBowler
  ) {
    return res.status(400).json({ message: "Missing required parameters for match start" });
  }
  
  if (state.setupPhase !== 3) {
    return res.status(400).json({ message: "Cannot start match: Not in Innings Setup phase" });
  }

  takeSnapshot(); // SNAPSHOT
  
  // Set the match over limit
  const oversString = matchOvers ? String(matchOvers).trim() : '0';
  let totalBalls = 0;
  
  if (oversString && oversString !== '0') {
      const parts = oversString.split('.');
      const fullOvers = parseInt(parts[0]) || 0;
      // Assuming the decimal part represents balls (0-5)
      const ballsInCurrentOver = parseInt(parts[1]) || 0;
      
      // Calculate total balls, ensuring ballsInCurrentOver is capped at 5
      totalBalls = (fullOvers * 6) + Math.min(5, ballsInCurrentOver);
  }
  
  state.matchBallLimit = totalBalls; 
  state.finalResult = null;

  state.battingTeam = battingTeam;
  state.bowlingTeam = battingTeam === "teamA" ? "teamB" : "teamA";

  ensurePlayerExists(openingStriker);
  ensurePlayerExists(openingNonStriker);
  ensureBowlerExists(startingBowler);

  state.striker = openingStriker;
  state.nonStriker = openingNonStriker;
  state.currentBowler = startingBowler;

  state.battingOrder = [openingStriker, openingNonStriker]; // SET initial batting order
  state.nextBatsmanIndex = 2;

  state.awaitingNewBatsman = false;
  state.awaitingNewBowler = false;
  state.lastManStandingMode = false;
  
  state.fallOfWickets = []; // RESET

  state.matchStarted = true;
  state.setupPhase = 4; // Match Live
  
  if (state.matchBallLimit > 0) {
      log(`Match limit set to ${formatOvers(state.matchBallLimit)} overs.`);
  }

  log(
    `Innings ${state.innings} started. ${state.teams[state.battingTeam].name} batting.`
  );

  res.json({ message: "Innings started", state });
});

/* -------------------------
   END INNINGS (1 → 2 or Match End)
------------------------- */
app.post("/api/endInnings", (req, res) => {
  if (state.innings === 2) {
    if (checkForMatchEnd(res)) return;
    
    state.matchStarted = false;
    state.setupPhase = 5;
    state.finalResult = `MATCH ENDED MANUALLY. No official result recorded.`;
    log(`Innings 2 ended manually. Match finished.`);
    return res.json({ message: "Innings 2 ended. Match Finished.", finalResult: state.finalResult, state });
  }

  if (state.innings !== 1)
    return res.status(400).json({ message: "Can only end innings 1 or 2" });

  takeSnapshot(); // SNAPSHOT

  state.innings1Score = {
    score: state.score,
    wickets: state.wickets,
    balls: state.balls,
    battingTeam: state.battingTeam,
  };

  state.target = state.score + 1;
  state.innings = 2;

  state.matchStarted = false;
  state.setupPhase = 3; // Back to setup phase for Innings 2

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

  state.bowlers = []; // Bowlers reset for new innings
  state.players = {}; // Player stats reset for new innings
  state.finalResult = null; // Clear result

  state.awaitingNewBatsman = false;
  state.awaitingNewBowler = false;
  state.lastOverBowler = null;
  state.lastManStandingMode = false;
  
  state.battingOrder = []; // RESET
  state.nextBatsmanIndex = 2;
  
  state.fallOfWickets = []; // RESET

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

  takeSnapshot(); // SNAPSHOT
  
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
    if (!state.lastManStandingMode) { 
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
    if (!state.lastManStandingMode) {
      [state.striker, state.nonStriker] = [
        state.nonStriker,
        state.striker,
      ];
    }

    state.lastOverBowler = state.currentBowler;
    state.awaitingNewBowler = true;
    state.matchStarted = false; // Pause match for selection

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

  takeSnapshot(); // SNAPSHOT

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
  
  // ADDED: Record Fall of Wicket
  state.fallOfWickets.push({
      player: bat.name,
      wicketType: wicketType,
      score: state.score,
      wickets: state.wickets,
      overs: formatOvers(state.balls),
  });
  
  log(`${bat.name} OUT (${wicketType})`);

  // Last Man Standing Logic - Dynamic for any team size N
  const totalPlayers = state.playerLists[state.battingTeam].length;
  
  // Innings is over only when totalPlayers wickets have fallen.
  const isMatchOver = state.wickets >= totalPlayers; 
  
  // Last man out (inning over)
  if (state.lastManStandingMode) {
      state.striker = null;
      state.nonStriker = null;
      state.matchStarted = false;
      log("All out. Innings ended.");
      if (state.innings === 2 && checkForMatchEnd(res)) return;

      return res.json({
          message: "All out. Innings ended",
          state,
      });
  }

  // Wicket: Always ask for new batsman (unless all out). 
  state.awaitingNewBatsman = true;
  state.striker = null; // Struck player is out, new striker is needed.
  
  // over ended?
  if (state.balls % 6 === 0) {
    state.awaitingNewBowler = true;
    state.lastOverBowler = state.currentBowler;
    state.matchStarted = false; // Pause match
  } else {
    // If we are awaiting a new batsman, the match must be paused.
    state.matchStarted = false;
  }


  res.json({
    message: "Wicket recorded",
    awaitingNewBatsman: state.awaitingNewBatsman,
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

  takeSnapshot(); // SNAPSHOT

  const { name } = req.body;
  
  if (name === state.nonStriker) {
      // If the user selected the non-striker, just swap strike
      [state.striker, state.nonStriker] = [state.nonStriker, state.striker];
      log(`New batsman selection was non-striker: strike swapped.`);
  } else {
      ensurePlayerExists(name);
      state.striker = name;
      // Add to batting order only if not already there
      if (!state.battingOrder.includes(name)) {
        state.battingOrder.push(name);
      }
      log(`New batsman: ${name}`);
  }
  
  state.awaitingNewBatsman = false;
  state.matchStarted = true;

  res.json({ message: "New batsman added/strike swapped", state });
});

/* -------------------------
   ACTIVATE LAST MAN STANDING MODE
------------------------- */
app.post("/api/activateLMS", (req, res) => {
    // Only allow this if a wicket has just fallen and we are waiting for a new batsman
    if (!state.awaitingNewBatsman) {
        return res.status(400).json({ message: "Cannot activate LMS: Not currently awaiting a new batsman." });
    }

    takeSnapshot(); // SNAPSHOT
    
    // 1. Move the non-striker to the striker position
    if (!state.striker && state.nonStriker) {
        state.striker = state.nonStriker;
    } else if (!state.striker && !state.nonStriker) {
         return res.status(400).json({ message: "Cannot activate LMS: No one left to bat or incorrect state." });
    }

    // 2. Activate LMS mode
    state.lastManStandingMode = true;
    state.nonStriker = null; // Remove non-striker

    // 3. Resume play
    state.awaitingNewBatsman = false;
    state.matchStarted = true;

    log("Last Man Standing Mode activated manually (forfeit remaining batsmen).");

    res.json({ message: "Last Man Standing Mode activated", state });
});


/* -------------------------
   EXTRAS (WIDE +1)
------------------------- */
app.post("/api/wide", (req, res) => {
    if (!state.matchStarted)
        return res.status(400).json({ message: "Match not started" });

    if (state.awaitingNewBatsman)
        return res.status(400).json({ message: "Awaiting new batsman" });

    if (state.awaitingNewBowler)
        return res.status(400).json({ message: "Awaiting next bowler" });

    takeSnapshot(); // SNAPSHOT

    // Wide: +1 penalty run
    state.score++;
    
    if (state.currentBowler) {
        ensureBowlerExists(state.currentBowler).runsConceded++;
        ensureBowlerExists(state.currentBowler).totalBalls++; 
    }

    log(`Wide (Total +1)`);
    
    if (checkForMatchEnd(res)) return;

    res.json({ message: "Wide recorded (+1)", state });
});

/* -------------------------
   EXTRAS (NO BALL +1)
------------------------- */
app.post("/api/noball", (req, res) => {
    if (!state.matchStarted)
        return res.status(400).json({ message: "Match not started" });

    if (state.awaitingNewBatsman)
        return res.status(400).json({ message: "Awaiting new batsman" });

    if (state.awaitingNewBowler)
        return res.status(400).json({ message: "Awaiting next bowler" });
    
    takeSnapshot(); // SNAPSHOT

    // No Ball: +1 penalty run
    state.score++;
    if (state.currentBowler) {
        ensureBowlerExists(state.currentBowler).runsConceded++; 
    }

    log(`No-ball (Total +1)`);

    if (checkForMatchEnd(res)) return;

    res.json({ message: "No Ball recorded (+1)", state });
});


/* -------------------------
   EXTRAS (wide / noball - ADVANCED)
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

  takeSnapshot(); // SNAPSHOT

  const { type, extraRuns } = req.body;

  if (!type || (type !== "wide" && type !== "noball"))
    return res
      .status(400)
      .json({ message: "Invalid extra type" });

  const extra = parseInt(extraRuns) || 0;
  let totalExtra = 1 + extra; // +1 penalty + runs

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

    log(`No-ball +${extra} (Total +${totalExtra})`);
    
    // Rotate strike if odd total extra runs (only if extra > 0)
    if (totalExtra % 2 === 1) {
        if (!state.lastManStandingMode) { 
            [state.striker, state.nonStriker] = [state.nonStriker, state.striker];
            log("Strike rotated (odd total runs on no-ball)");
        }
    }

  } else { // wide
    // wide = extras only, counts as 1 ball for wide (totalBalls, but not state.balls)
    if (state.currentBowler)
      ensureBowlerExists(state.currentBowler).runsConceded += extra;

    state.score += extra;
    
    // Wide counts on bowler totalBalls as it resets the ball count for the over.
    if (state.currentBowler) {
        ensureBowlerExists(state.currentBowler).totalBalls++;
        log("Bowler total balls incremented for wide.");
    }
    
    log(`Wide +${extra} (Total +${totalExtra})`);
    
    // Rotate strike if odd total extra runs
    if (totalExtra % 2 === 1) {
        if (!state.lastManStandingMode) { 
            [state.striker, state.nonStriker] = [state.nonStriker, state.striker];
            log("Strike rotated (odd total runs on wide)");
        }
    }
  }

  if (checkForMatchEnd(res)) return;

  res.json({ message: "Extras recorded", state });
});

/* -------------------------
   SELECT BOWLER
------------------------- */
app.post("/api/selectBowler", (req, res) => {
  const { bowler } = req.body;

  if (!bowler)
    return res.json({
      success: false,
      error: "No bowler provided",
      state,
    });
    
  // Prevent bowler from being one of the batsmen if not in Last Man Standing mode
  if (!state.lastManStandingMode && (bowler === state.striker || bowler === state.nonStriker)) {
    return res.status(400).json({
        success: false,
        message: "Bowler cannot be one of the current batsmen (striker or non-striker)."
    });
  }
  
  takeSnapshot(); // SNAPSHOT

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

  takeSnapshot(); // SNAPSHOT

  if (action === "swap") {
    if (!state.striker || !state.nonStriker) {
        return res.status(400).json({ message: "Cannot swap. Striker or Non-Striker is missing (e.g., Last Man Standing mode)." });
    }
    [state.striker, state.nonStriker] = [
      state.nonStriker,
      state.striker,
    ];
    log("Strike swapped manually");
    return res.json({ message: "Strike swapped", state });
  }

  if (action === "set_striker") {
    if (!name)
      return res
        .status(400)
        .json({ message: "Player name required" });
        
    const player = ensurePlayerExists(name);
    
    if (player.out)
        return res.status(400).json({ message: `${name} is already out and cannot be set as striker.` });

    if (state.nonStriker === name) {
      // If the selected player is the non-striker, just swap them.
      [state.striker, state.nonStriker] = [
        state.nonStriker,
        state.striker,
      ];
      log(`Strike set to ${name} (was non-striker)`);
    } else if (state.striker !== name) {
      // If the selected player is neither the striker nor non-striker, 
      // the current striker becomes the non-striker, and the selected player becomes the striker.
      if (state.striker) {
          state.nonStriker = state.striker;
      }
      state.striker = name;
      log(`Strike changed - new striker: ${name}`);
    } 

    return res.json({
      message: "Striker changed",
      state,
    });
  }

  if (action === "set_non_striker") {
    if (!name)
      return res
        .status(400)
        .json({ message: "Player name required" });

    const player = ensurePlayerExists(name);
    
    if (player.out)
        return res.status(400).json({ message: `${name} is already out and cannot be set as non-striker.` });
    
    if (state.striker === name)
        return res.status(400).json({ message: `${name} is currently the striker. Cannot set as non-striker.` });

    state.nonStriker = name;
    log(`Non-Striker set to: ${name}`);

    return res.json({
      message: "Non-Striker changed",
      state,
    });
  }


  return res
    .status(400)
    .json({ message: "Invalid action" });
});

/* -------------------------
   UNDO LAST ACTION
------------------------- */
app.post("/api/undo", (req, res) => {
  if (state.stateHistory.length === 0) {
    return res.status(400).json({ message: "No history to undo" });
  }

  // Pop the last snapshot
  const lastState = state.stateHistory.pop();
  
  // Save current history (which is the previous history)
  const currentHistory = state.stateHistory;
  
  // Shallow copy the properties from lastState to state
  Object.assign(state, lastState); 
  
  // Restore the stateHistory (which was explicitly removed from the snapshot)
  state.stateHistory = currentHistory;

  // Remove the last log entry, as the action it represents has been undone
  if (state.log.length > 0) {
    state.log.pop();
  }
  
  log("Last action UNDONE");

  res.json({ message: "Undo successful", state });
});


/* -------------------------
   RESET
------------------------- */
app.post("/api/reset", (req, res) => {
  // Re-load players on reset in case of file change
  loadPlayers(); 

  state = {
    matchStarted: false,
    setupPhase: 1,
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
    matchBallLimit: 0,
    finalResult: null,
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
    battingOrder: [], // RESET
    nextBatsmanIndex: 2,
    allPlayerNames: allPlayerNames,
    playerLists: { teamA: [], teamB: [] },
    log: [],
    stateHistory: [],
    fallOfWickets: [], // RESET
  };

  res.json({ message: "Reset done", state });
});

/* STATIC FILE SERVING */
app.use(express.static(path.join(__dirname, "public")));

// Fallback for SPA routing
app.get("*", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);