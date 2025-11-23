const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

/* -------------------------
   GLOBAL CORS
------------------------- */
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

/* -------------------------
   JSON PARSER SAFETY
------------------------- */
app.use(
  express.json({
    verify: (req, res, buf) => {
      try {
        if (buf.length > 0) JSON.parse(buf.toString());
      } catch (err) {
        console.log("❌ Invalid JSON:", buf.toString());
        res.status(400).json({ message: "Invalid JSON body" });
        throw err;
      }
    },
  })
);

/* -------------------------
   MATCH STATE
------------------------- */
let state = {
  // Global Match Info
  matchStarted: false,
  teams: {
    teamA: { name: "Team A", players: [] }, // array of player objects
    teamB: { name: "Team B", players: [] }, // array of player objects
  },

  // Innings Tracking
  innings: 1, // 1 or 2
  innings1Score: { score: 0, wickets: 0, balls: 0, battingTeam: null },
  target: 0,

  battingTeam: null, // "teamA" or "teamB"
  bowlingTeam: null, // "teamB" or "teamA"

  // Current Innings Score
  score: 0,
  wickets: 0,
  balls: 0, // total legal balls in innings

  // Batting (references to player objects in the current batting team)
  battingOrder: [],    // array refs to players (same objects)
  nextBatsmanIndex: 2,
  striker: null,       // player.name
  nonStriker: null,    // player.name

  // Bowling (stats only, tied to a name from the bowling team)
  bowlers: [],         // array of bowler objects { name, totalBalls, runsConceded, wickets }
  currentBowler: null, // bowler.name

  log: [],
};

function log(msg) {
  state.log.push(`${new Date().toLocaleTimeString()} - ${msg}`);
}

/* -------------------------
   HELPERS
------------------------- */
function findPlayerObj(name) {
  // Find the player object in the current batting team's roster
  if (!state.battingTeam) return null;
  return state.teams[state.battingTeam].players.find((p) => p.name === name);
}

function findBowlerObj(name) {
  // Find the bowler stats object in the active bowlers list
  return state.bowlers.find((b) => b.name === name);
}

function formatOversFromBalls(balls) {
  return `${Math.floor(balls / 6)}.${balls % 6}`;
}

function checkForMatchEnd(res) {
    if (state.innings !== 2) return false;
    
    let message = null;
    
    if (state.score >= state.target) {
        const wicketsLeft = state.teams[state.battingTeam].players.length - state.wickets;
        message = `${state.teams[state.battingTeam].name} WIN by ${wicketsLeft} wickets! 🏆`;
    } else if (state.wickets >= state.teams[state.battingTeam].players.length - 1) {
        const runsDiff = state.target - 1 - state.score;
        message = `${state.teams[state.bowlingTeam].name} WIN by ${runsDiff} runs! 🏆`;
    } else if (state.balls >= state.innings1Score.balls && state.score < state.target) {
         if (state.score === state.target - 1) {
             message = "MATCH TIED! 🤝";
        } else {
             const runsDiff = state.target - 1 - state.score;
             message = `${state.teams[state.bowlingTeam].name} WIN by ${runsDiff} runs! 🏆`;
        }
    }

    if (message) {
        log(message);
        state.matchStarted = false; // Freeze scoring
        res.json({ message: "Match ended", finalResult: message, state });
        return true;
    }
    return false;
}

/* -------------------------
   GET SCORE
------------------------- */
app.get("/api/score", (req, res) => {
  // Get active batting roster for display, falling back to teamA/B if batting team isn't set
  const activeTeamKey = state.battingTeam || 'teamA';
  const battingRoster = state.teams[activeTeamKey].players;

  const players = battingRoster.map((p) => ({
    name: p.name,
    runs: p.runs,
    ballsFaced: p.ballsFaced,
    fours: p.fours,
    sixes: p.sixes,
    strikeRate: p.ballsFaced > 0 ? ((p.runs / p.ballsFaced) * 100).toFixed(2) : "0.00",
  }));

  const bowlers = state.bowlers.map((b) => ({
    name: b.name,
    overs: formatOversFromBalls(b.totalBalls),
    balls: b.totalBalls,
    runsConceded: b.runsConceded,
    wickets: b.wickets,
    economy: b.totalBalls > 0 ? ((b.runsConceded / (b.totalBalls/6)).toFixed(2)) : "0.00",
  }));

  res.json({
    // New Innings Data
    innings: state.innings,
    innings1Score: state.innings1Score,
    target: state.target,

    score: state.score,
    wickets: state.wickets,
    balls: state.balls,
    striker: state.striker,
    nonStriker: state.nonStriker,
    nextBatsmanIndex: state.nextBatsmanIndex,
    teams: state.teams,
    battingTeam: state.battingTeam,
    bowlingTeam: state.bowlingTeam,
    battingOrder: state.battingOrder.map((p) => p.name),
    players, 
    bowlers, 
    currentBowler: state.currentBowler,
    log: state.log,
    matchStarted: state.matchStarted,
  });
});

/* ------------------------------------
   1. CREATE TEAMS (NEW ENDPOINT)
   body: {
     teamA: { name: "A Name", players: ["P1","P2",...]},
     teamB: { name: "B Name", players: ["Q1","Q2",...]},
   }
------------------------------------ */
app.post("/api/createTeams", (req, res) => {
  const { teamA, teamB } = req.body;

  if (!teamA || !teamB || !teamA.players || !teamB.players) {
    return res.status(400).json({ message: "Missing required team data." });
  }
  if (teamA.players.length < 2 || teamB.players.length < 2) {
    return res.status(400).json({ message: "Each team must have at least 2 players." });
  }

  // Helper to create player objects
  const createPlayerObjs = (name) => ({
    name,
    runs: 0,
    ballsFaced: 0,
    fours: 0,
    sixes: 0,
  });

  // Setup Teams (Resets existing team data)
  state.teams.teamA = {
    name: teamA.name || "Team A",
    players: teamA.players.map(createPlayerObjs),
  };
  state.teams.teamB = {
    name: teamB.name || "Team B",
    players: teamB.players.map(createPlayerObjs),
  };

  // Reset all match-specific variables to pre-start state
  state.innings = 1;
  state.innings1Score = { score: 0, wickets: 0, balls: 0, battingTeam: null };
  state.target = 0;
  state.battingTeam = null;
  state.bowlingTeam = null;
  state.score = 0;
  state.wickets = 0;
  state.balls = 0;
  state.battingOrder = [];
  state.nextBatsmanIndex = 2;
  state.striker = null;
  state.nonStriker = null;
  state.bowlers = [];
  state.currentBowler = null;
  state.log = [];
  state.matchStarted = false;


  log(`Teams created: ${state.teams.teamA.name} and ${state.teams.teamB.name}. Ready to start match.`);
  res.json({ message: "Teams created successfully. Proceed to start the innings.", state });
});


/* ------------------------------------
   2. START INNINGS (MODIFIED ENDPOINT)
   body: {
     battingTeam: "teamA" | "teamB",
     openingStriker: "P1 name",
     openingNonStriker: "P2 name",
     startingBowler: "Q1 name"
   }
------------------------------------ */
app.post("/api/setTeamsAndMatch", (req, res) => {
  const { battingTeam, openingStriker, openingNonStriker, startingBowler } = req.body;

  // 1. Check if Teams are already created
  if (state.teams.teamA.players.length === 0 || state.teams.teamB.players.length === 0) {
    return res.status(400).json({ message: "Teams must be created first using /api/createTeams." });
  }

  // 2. Basic Validation
  if (!battingTeam || !openingStriker || !openingNonStriker || !startingBowler) {
    return res.status(400).json({ message: "Missing required starting configuration parameters" });
  }
  
  // 3. Handle 2nd Innings Check
  if (state.innings === 2) {
    if (state.target === 0) {
      return res.status(400).json({ message: "Cannot start 2nd innings setup without ending the 1st innings first." });
    }
    // Also, ensure the selected batting team matches the team defined in the swap
    if (req.body.battingTeam !== state.battingTeam) {
       return res.status(400).json({ message: `The 2nd innings must be started by the correct chasing team: ${state.teams[state.battingTeam].name}` });
    }
  }


  // 4. Determine Batting/Bowling Sides (Only needed for Innings 1)
  if (state.innings === 1) {
    if (battingTeam !== "teamA" && battingTeam !== "teamB") {
      return res.status(400).json({ message: "Invalid battingTeam specified" });
    }
    state.battingTeam = battingTeam;
    state.bowlingTeam = battingTeam === "teamA" ? "teamB" : "teamA";
  }

  // Get current rosters based on active team in state
  const battingRoster = state.teams[state.battingTeam].players;
  const bowlingRoster = state.teams[state.bowlingTeam].players;

  // 5. Validate Opening Batsmen
  const strikerObj = battingRoster.find((p) => p.name === openingStriker);
  const nonStrikerObj = battingRoster.find((p) => p.name === openingNonStriker);
  if (!strikerObj || !nonStrikerObj || strikerObj === nonStrikerObj) {
    return res.status(400).json({ message: "Invalid or duplicate opening batsmen for the batting team" });
  }

  // 6. Set Batting Order & Batsmen
  state.battingOrder = [...battingRoster];
  state.striker = openingStriker;
  state.nonStriker = openingNonStriker;

  // Find the index of the next batsman after the openers
  const openerNames = [openingStriker, openingNonStriker];
  state.nextBatsmanIndex = state.battingOrder.findIndex(p => !openerNames.includes(p.name));
  if (state.nextBatsmanIndex === -1) state.nextBatsmanIndex = state.battingOrder.length; 

  // 7. Validate and Set Bowler
  const bowlerObj = bowlingRoster.find((p) => p.name === startingBowler);
  if (!bowlerObj) {
    return res.status(400).json({ message: "Starting bowler is not in the bowling team roster" });
  }

  // 8. Initialise bowlers list with stats objects for all potential bowlers 
  if (state.bowlers.length === 0 || state.innings === 1) {
    state.bowlers = bowlingRoster.map(p => ({
      name: p.name,
      totalBalls: 0,
      runsConceded: 0,
      wickets: 0,
    }));
  }
  state.currentBowler = startingBowler;


  // 9. Mark Match as Started
  state.matchStarted = true;

  // 10. Update log based on innings
  if (state.innings === 1) {
    log(`Match started! ${state.teams[state.battingTeam].name} is batting against ${state.teams[state.bowlingTeam].name}.`);
  } else {
    log(`Innings 2 resumed. Opening: ${state.striker} & ${state.nonStriker}. Starting bowler: ${state.currentBowler}. Target: ${state.target}`);
  }
  
  res.json({ message: "Innings started", state });
});

/* -------------------------
   END 1ST INNINGS & START 2ND 
------------------------- */
app.post("/api/endInnings", (req, res) => {
  if (state.innings !== 1) {
    return res.status(400).json({ message: "Innings must be 1 to call this endpoint." });
  }
  if (!state.matchStarted) {
    return res.status(400).json({ message: "Innings not active." });
  }

  // 1. Save 1st Innings Score
  state.innings1Score.score = state.score;
  state.innings1Score.wickets = state.wickets;
  state.innings1Score.balls = state.balls;
  state.innings1Score.battingTeam = state.battingTeam;
  
  // 2. Set Target for 2nd Innings
  state.target = state.score + 1;
  state.innings = 2;
  state.matchStarted = false; // Pause scoring until 2nd innings openers are set

  log(`✅ Innings 1 ended! ${state.teams[state.battingTeam].name} scored ${state.score}/${state.wickets} in ${formatOversFromBalls(state.balls)} overs.`);
  log(`🎯 Target for 2nd innings: ${state.target}`);

  // 3. Swap Teams
  const newBattingTeam = state.bowlingTeam;
  const newBowlingTeam = state.battingTeam;
  state.battingTeam = newBattingTeam;
  state.bowlingTeam = newBowlingTeam;

  // 4. Reset Current Innings Score & Bowler Stats
  state.score = 0;
  state.wickets = 0;
  state.balls = 0;
  
  state.bowlers = state.teams[state.bowlingTeam].players.map(p => ({
    name: p.name,
    totalBalls: 0,
    runsConceded: 0,
    wickets: 0,
  }));
  state.currentBowler = null; 
  
  // Batting state cleared, waiting for 2nd innings setup
  state.battingOrder = []; 
  state.nextBatsmanIndex = 2;
  state.striker = null;
  state.nonStriker = null;

  log(`🔄 Innings 2 setup required for ${state.teams[state.battingTeam].name} who needs ${state.target} to win.`);
  res.json({ message: "Innings 1 ended, waiting for Innings 2 setup.", state });
});


/* -------------------------
   SCORING ENDPOINTS (No changes needed)
------------------------- */
app.post("/api/selectBowler", (req, res) => {
  if (!state.matchStarted) {
    return res.status(400).json({ message: "Match not started or finished." });
  }
  const bowler = req.body.bowler;
  if (!bowler || !state.bowlingTeam) {
    return res.status(400).json({ message: "Invalid request or bowling team not set" });
  }
  const bowlingRoster = state.teams[state.bowlingTeam].players;
  if (!bowlingRoster.find((p) => p.name === bowler)) {
    return res.status(400).json({ message: `Bowler ${bowler} is not in the ${state.teams[state.bowlingTeam].name} roster.` });
  }
  if (!findBowlerObj(bowler)) {
     return res.status(400).json({ message: "Bowler stats not initialised. Use /api/setTeamsAndMatch first." });
  }

  state.currentBowler = bowler;
  log(`Current bowler changed to ${bowler}`);
  res.json({ message: "Current bowler updated", currentBowler: state.currentBowler });
});

app.post("/api/run/:value", (req, res) => {
  if (!state.matchStarted) return res.status(400).json({ message: "Match not started or finished." });
  const runs = parseInt(req.params.value);
  if (isNaN(runs)) return res.status(400).json({ message: "Invalid run value" });
  if (!state.striker || !state.currentBowler) return res.status(400).json({ message: "Set players and select a bowler before scoring" });

  state.score += runs;
  state.balls++;

  const batsman = findPlayerObj(state.striker);
  if (batsman) {
    batsman.runs += runs;
    batsman.ballsFaced++;
    if (runs === 4) batsman.fours++;
    if (runs === 6) batsman.sixes++;
  }

  const bowler = findBowlerObj(state.currentBowler);
  if (bowler) {
    bowler.totalBalls += 1;
    bowler.runsConceded += runs;
  }

  log(`🏏 ${state.striker} scored ${runs} (bowler: ${state.currentBowler})`);

  if (checkForMatchEnd(res)) return;

  if (runs % 2 === 1) {
    const tmp = state.striker;
    state.striker = state.nonStriker;
    state.nonStriker = tmp;
    log("🔄 Strike rotated (odd runs)");
  }

  if (state.balls % 6 === 0) {
    const tmp = state.striker;
    state.striker = state.nonStriker;
    state.nonStriker = tmp;
    log(`➡ End of Over ${formatOversFromBalls(state.balls)} - strike rotated. Select next bowler.`);
  }

  res.json({ message: "Run recorded", state });
});

app.post("/api/wide", (req, res) => {
  if (!state.matchStarted) return res.status(400).json({ message: "Match not started or finished." });
  if (!state.currentBowler) return res.status(400).json({ message: "Select a bowler first" });

  state.score += 1;
  const bowler = findBowlerObj(state.currentBowler);
  if (bowler) bowler.runsConceded += 1;

  log(`⚠ Wide by ${state.currentBowler} (+1)`);

  if (checkForMatchEnd(res)) return;

  res.json({ message: "Wide recorded", state });
});

app.post("/api/noball", (req, res) => {
  if (!state.matchStarted) return res.status(400).json({ message: "Match not started or finished." });
  if (!state.currentBowler) return res.status(400).json({ message: "Select a bowler first" });

  state.score += 1;
  const bowler = findBowlerObj(state.currentBowler);
  if (bowler) bowler.runsConceded += 1;

  log(`⚠ No-ball by ${state.currentBowler} (+1)`);

  if (checkForMatchEnd(res)) return;

  res.json({ message: "No-ball recorded", state });
});

app.post("/api/wicket", (req, res) => {
  if (!state.matchStarted) return res.status(400).json({ message: "Match not started or finished." });
  if (!state.striker || !state.currentBowler) return res.status(400).json({ message: "Set players and select a bowler before wicket" });

  const batsman = findPlayerObj(state.striker);
  if (batsman) batsman.ballsFaced++;

  state.wickets++;
  state.balls++;

  const bowler = findBowlerObj(state.currentBowler);
  if (bowler) {
    bowler.totalBalls += 1;
    bowler.wickets += 1;
  }

  log(`❌ ${state.striker} OUT (bowler: ${state.currentBowler})`);

  if (checkForMatchEnd(res)) return;

  if (state.nextBatsmanIndex < state.battingOrder.length) {
    const newBatsmanObj = state.battingOrder[state.nextBatsmanIndex];
    state.striker = newBatsmanObj.name;
    state.nextBatsmanIndex++;
    log(`👤 New batsman: ${state.striker}`);
  } else {
    state.striker = null;
    state.nonStriker = null;
    log("⚠ Innings ended - no batsman left");
  }

  if (state.balls % 6 === 0) {
    if(state.striker && state.nonStriker) {
      const tmp = state.striker;
      state.striker = state.nonStriker;
      state.nonStriker = tmp;
    }
    log(`➡ End of Over ${formatOversFromBalls(state.balls)} - strike rotated. Select next bowler.`);
  }

  res.json({ message: "Wicket recorded", state });
});

/* -------------------------
   RESET
------------------------- */
app.post("/api/reset", (req, res) => {
  state = {
    matchStarted: false,
    teams: {
      teamA: { name: "Team A", players: [] },
      teamB: { name: "Team B", players: [] },
    },
    innings: 1,
    innings1Score: { score: 0, wickets: 0, balls: 0, battingTeam: null },
    target: 0,
    battingTeam: null,
    bowlingTeam: null,
    score: 0,
    wickets: 0,
    balls: 0,
    battingOrder: [],
    nextBatsmanIndex: 2,
    striker: null,
    nonStriker: null,
    bowlers: [],
    currentBowler: null,
    log: [],
  };
  res.json({ message: "Reset done", state });
});

/* -------------------------
   STATIC FRONTEND
------------------------- */
app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* -------------------------
   START SERVER
------------------------- */
app.listen(3000, "0.0.0.0", () => {
  console.log("🚀 Server running at http://192.168.10.42:3000");
});