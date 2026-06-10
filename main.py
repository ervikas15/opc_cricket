"""
Cricket Scorer — FastAPI Backend + Gradio Auth
Mobile-first cricket scoring app for live match scoring.
"""

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from typing import Optional
import gradio as gr
import os
import httpx
import json

# ============================================================
# FastAPI App
# ============================================================
app = FastAPI(title="Cricket Scorer", version="1.0.0")

# Predefined player roster
PLAYER_ROSTER = [
    "Vikas", "Arpit", "Naren", "Trijal", "Hrushi", "Shiprak", "Pranay",
    "Vaibhav", "PC Sinha", "Sandeep", "Amit", "Anurag", "Hari", "Umesh",
    "Puneet", "Abhishek", "Shiva", "Tarun", "Vasant", "Soham", "Raj"
]

# ============================================================
# In-Memory Match State
# ============================================================
match_data: Optional[dict] = None


def create_innings(batting_team, bowling_team, batting_players, bowling_players, target=None):
    """Create a fresh innings data structure."""
    return {
        "batting_team": batting_team,
        "bowling_team": bowling_team,
        "batting_players": batting_players,
        "bowling_players": bowling_players,
        "runs": 0,
        "wickets": 0,
        "balls": 0,
        "extras": {"wides": 0, "no_balls": 0, "byes": 0, "leg_byes": 0},
        "striker": None,
        "non_striker": None,
        "current_bowler": None,
        "batsmen": {},
        "bowlers": {},
        "this_over": [],
        "ball_log": [],
        "fow": [],
        "partnership": {"runs": 0, "balls": 0},
        "target": target,
    }


# ============================================================
# Request Models
# ============================================================
class MatchSetup(BaseModel):
    team1_name: str
    team2_name: str
    overs: int
    players_per_team: int = 99
    team1_players: Optional[list[str]] = None
    team2_players: Optional[list[str]] = None


class GenerateTeamsRequest(BaseModel):
    available_players: Optional[list[str]] = None


class OpeningSelection(BaseModel):
    striker: str
    non_striker: str
    bowler: str


class BallInput(BaseModel):
    runs: int = 0
    extra_type: str = "none"  # none, wide, no_ball, bye, leg_bye
    extra_runs: int = 0


class WicketInput(BaseModel):
    dismissal_type: str
    new_batsman: str
    runs_before_wicket: int = 0


class BowlerSelection(BaseModel):
    bowler: str


class ChangeBatsman(BaseModel):
    position: str  # 'striker' or 'non_striker'
    new_batsman: str


# ============================================================
# Helper Functions
# ============================================================
def get_overs_str(balls: int) -> str:
    """Convert ball count to overs string (e.g. 14.3)."""
    return f"{balls // 6}.{balls % 6}"


def get_current_innings():
    """Get the active innings dict."""
    if not match_data:
        raise HTTPException(400, "No match created")
    return match_data["innings"][match_data["current_innings"]]


def get_available_batsmen(innings: dict) -> list[str]:
    """Get batsmen who haven't batted or are not out."""
    batted = set(innings["batsmen"].keys())
    available = []
    for p in innings["batting_players"]:
        if p not in batted:
            available.append(p)
    return available


def get_last_bowler(innings: dict) -> Optional[str]:
    """Get the bowler who bowled the previous over (cannot bowl consecutive overs)."""
    # Walk backwards through ball_log to find the last legal delivery of the previous over
    if innings["balls"] == 0:
        return None
    current_over_num = innings["balls"] // 6
    for event in reversed(innings["ball_log"]):
        if event.get("over_number", 0) < current_over_num:
            return event.get("bowler")
    return None


def check_innings_complete(innings: dict) -> bool:
    """Check if the current innings is over (overs done or target chased)."""
    overs_done = innings["balls"] // 6
    if overs_done >= match_data["overs_limit"]:
        return True
    if innings["target"] and innings["runs"] >= innings["target"]:
        return True
    return False


def get_match_result() -> str:
    """Determine match result string."""
    if not match_data or len(match_data["innings"]) < 2:
        return ""
    inn1 = match_data["innings"][0]
    inn2 = match_data["innings"][1]

    if inn2["runs"] >= (inn1["runs"] + 1):
        # Count batsmen who are still not out
        not_out = sum(1 for b in inn2["batsmen"].values() if not b["out"])
        wickets_remaining = max(not_out, 1)
        return f"{inn2['batting_team']} won by {wickets_remaining} wicket{'s' if wickets_remaining != 1 else ''}"
    elif inn2["runs"] < inn1["runs"]:
        run_diff = inn1["runs"] - inn2["runs"]
        return f"{inn1['batting_team']} won by {run_diff} run{'s' if run_diff != 1 else ''}"
    else:
        return "Match Tied!"


# ============================================================
# API Endpoints
# ============================================================

@app.get("/api/state")
def get_state():
    """Return the full match state."""
    if not match_data:
        return None
    # Attach result if completed
    state = dict(match_data)
    if state["status"] == "completed":
        state["result"] = get_match_result()
    return state


@app.post("/api/new-match")
def create_match(setup: MatchSetup):
    """Create a new match."""
    global match_data

    if not setup.team1_name.strip() or not setup.team2_name.strip():
        raise HTTPException(400, "Team names are required")
    if setup.overs < 1 or setup.overs > 50:
        raise HTTPException(400, "Overs must be between 1 and 50")

    # Use provided team players or fallback to all roster players
    team1_players = setup.team1_players if setup.team1_players else list(PLAYER_ROSTER)
    team2_players = setup.team2_players if setup.team2_players else list(PLAYER_ROSTER)

    match_data = {
        "status": "setup",
        "team1": {"name": setup.team1_name.strip(), "players": team1_players},
        "team2": {"name": setup.team2_name.strip(), "players": team2_players},
        "overs_limit": setup.overs,
        "players_per_team": setup.players_per_team,
        "current_innings": 0,
        "innings": [
            create_innings(
                setup.team1_name.strip(), setup.team2_name.strip(),
                team1_players, team2_players
            )
        ],
    }
    return {"status": "ok", "match": match_data}


@app.post("/api/set-openers")
def set_openers(selection: OpeningSelection):
    """Set opening batsmen and bowler to start an innings."""
    global match_data
    inn = get_current_innings()

    if selection.striker == selection.non_striker:
        raise HTTPException(400, "Striker and non-striker must be different")

    inn["striker"] = selection.striker
    inn["non_striker"] = selection.non_striker
    inn["current_bowler"] = selection.bowler

    # Initialize batsman stats
    for name in [selection.striker, selection.non_striker]:
        inn["batsmen"][name] = {
            "runs": 0, "balls": 0, "fours": 0, "sixes": 0,
            "out": False, "how_out": "", "status": "batting"
        }

    # Initialize bowler stats
    inn["bowlers"][selection.bowler] = {
        "balls": 0, "runs": 0, "wickets": 0, "maidens": 0,
        "wides": 0, "no_balls": 0, "over_runs": 0
    }

    match_data["status"] = "batting"
    return {"status": "ok", "match": match_data}


@app.post("/api/score")
def record_ball(ball: BallInput):
    """Record a ball delivery."""
    global match_data
    if not match_data or match_data["status"] != "batting":
        raise HTTPException(400, "Match not in batting state")

    inn = get_current_innings()
    striker = inn["striker"]
    bowler = inn["current_bowler"]

    if not striker or not bowler:
        raise HTTPException(400, "Striker and bowler must be set")

    # Store event for undo
    event = {
        "type": "ball",
        "striker": striker,
        "non_striker": inn["non_striker"],
        "bowler": bowler,
        "runs": ball.runs,
        "extra_type": ball.extra_type,
        "extra_runs": ball.extra_runs,
        "total_runs_before": inn["runs"],
        "total_balls_before": inn["balls"],
        "total_wickets_before": inn["wickets"],
        "partnership_before": dict(inn["partnership"]),
        "extras_before": dict(inn["extras"]),
        "over_number": inn["balls"] // 6,
    }

    total_ball_runs = 0
    is_legal = True
    over_display = ""
    should_swap = False

    if ball.extra_type == "wide":
        is_legal = False
        total_ball_runs = 1 + ball.extra_runs
        inn["extras"]["wides"] += total_ball_runs
        inn["bowlers"][bowler]["wides"] += 1
        inn["bowlers"][bowler]["runs"] += total_ball_runs
        inn["bowlers"][bowler]["over_runs"] += total_ball_runs
        over_display = "Wd" + (f"+{ball.extra_runs}" if ball.extra_runs else "")
        should_swap = ball.extra_runs % 2 == 1

    elif ball.extra_type == "no_ball":
        is_legal = False
        total_ball_runs = 1 + ball.runs + ball.extra_runs
        inn["extras"]["no_balls"] += 1
        inn["bowlers"][bowler]["no_balls"] += 1
        inn["bowlers"][bowler]["runs"] += total_ball_runs
        inn["bowlers"][bowler]["over_runs"] += total_ball_runs
        if ball.runs > 0:
            inn["batsmen"][striker]["runs"] += ball.runs
            if ball.runs == 4:
                inn["batsmen"][striker]["fours"] += 1
            elif ball.runs >= 6:
                inn["batsmen"][striker]["sixes"] += 1
        nb_display_runs = ball.runs + ball.extra_runs
        over_display = "Nb" + (f"+{nb_display_runs}" if nb_display_runs else "")
        should_swap = (ball.runs + ball.extra_runs) % 2 == 1

    elif ball.extra_type == "bye":
        is_legal = True
        total_ball_runs = ball.runs
        inn["extras"]["byes"] += ball.runs
        inn["batsmen"][striker]["balls"] += 1
        inn["bowlers"][bowler]["balls"] += 1
        over_display = f"{ball.runs}b"
        should_swap = ball.runs % 2 == 1

    elif ball.extra_type == "leg_bye":
        is_legal = True
        total_ball_runs = ball.runs
        inn["extras"]["leg_byes"] += ball.runs
        inn["batsmen"][striker]["balls"] += 1
        inn["bowlers"][bowler]["balls"] += 1
        over_display = f"{ball.runs}lb"
        should_swap = ball.runs % 2 == 1

    else:  # normal delivery
        is_legal = True
        total_ball_runs = ball.runs
        inn["batsmen"][striker]["runs"] += ball.runs
        inn["batsmen"][striker]["balls"] += 1
        inn["bowlers"][bowler]["runs"] += ball.runs
        inn["bowlers"][bowler]["balls"] += 1
        inn["bowlers"][bowler]["over_runs"] += ball.runs
        should_swap = ball.runs % 2 == 1
        if ball.runs == 4:
            inn["batsmen"][striker]["fours"] += 1
            over_display = "4"
        elif ball.runs >= 6:
            inn["batsmen"][striker]["sixes"] += 1
            over_display = "6"
        else:
            over_display = str(ball.runs)

    # Update totals
    inn["runs"] += total_ball_runs
    if is_legal:
        inn["balls"] += 1
    inn["partnership"]["runs"] += total_ball_runs
    if is_legal:
        inn["partnership"]["balls"] += 1

    # Add to this over display
    inn["this_over"].append(over_display)

    # Swap strike on odd runs (skip if last man standing)
    if should_swap and inn["non_striker"] is not None:
        inn["striker"], inn["non_striker"] = inn["non_striker"], inn["striker"]

    event["is_legal"] = is_legal
    event["swapped"] = should_swap
    event["over_display"] = over_display

    # Store batsman stats snapshot for undo
    event["striker_stats_before"] = {
        "runs": inn["batsmen"][striker]["runs"] - (ball.runs if ball.extra_type in ["none", "no_ball"] else 0),
        "balls": inn["batsmen"][striker]["balls"] - (1 if ball.extra_type not in ["wide", "no_ball"] else 0),
        "fours": inn["batsmen"][striker]["fours"] - (1 if ball.runs == 4 and ball.extra_type in ["none", "no_ball"] else 0),
        "sixes": inn["batsmen"][striker]["sixes"] - (1 if ball.runs >= 6 and ball.extra_type in ["none", "no_ball"] else 0),
    }

    inn["ball_log"].append(event)

    # Check if over is complete
    over_complete = False
    if is_legal and inn["balls"] > 0 and inn["balls"] % 6 == 0:
        over_complete = True
        # Check for maiden
        if inn["bowlers"][bowler]["over_runs"] == 0:
            inn["bowlers"][bowler]["maidens"] += 1
        inn["bowlers"][bowler]["over_runs"] = 0
        # Swap strike at end of over (skip if last man standing)
        if inn["non_striker"] is not None:
            inn["striker"], inn["non_striker"] = inn["non_striker"], inn["striker"]

    # Check innings completion
    innings_complete = check_innings_complete(inn)

    # Check if target chased (2nd innings)
    if inn["target"] and inn["runs"] >= inn["target"]:
        match_data["status"] = "completed"
        innings_complete = True

    if innings_complete and match_data["status"] != "completed":
        if match_data["current_innings"] == 0:
            match_data["status"] = "innings_break"
        else:
            match_data["status"] = "completed"

    response = {
        "status": "ok",
        "match": match_data,
        "over_complete": over_complete,
        "innings_complete": innings_complete,
        "need_bowler": over_complete and not innings_complete,
    }

    if match_data["status"] == "completed":
        response["result"] = get_match_result()

    return response


@app.post("/api/wicket")
def record_wicket(wicket: WicketInput):
    """Record a wicket."""
    global match_data
    if not match_data or match_data["status"] != "batting":
        raise HTTPException(400, "Match not in batting state")

    inn = get_current_innings()
    striker = inn["striker"]
    bowler = inn["current_bowler"]

    # Store event for undo
    event = {
        "type": "wicket",
        "striker": striker,
        "non_striker": inn["non_striker"],
        "bowler": bowler,
        "dismissal_type": wicket.dismissal_type,
        "new_batsman": wicket.new_batsman,
        "runs_before_wicket": wicket.runs_before_wicket,
        "total_runs_before": inn["runs"],
        "total_balls_before": inn["balls"],
        "total_wickets_before": inn["wickets"],
        "partnership_before": dict(inn["partnership"]),
        "extras_before": dict(inn["extras"]),
        "over_number": inn["balls"] // 6,
        "striker_stats_snapshot": dict(inn["batsmen"][striker]),
    }

    # Add any runs scored before the wicket
    total_ball_runs = wicket.runs_before_wicket
    if wicket.runs_before_wicket > 0:
        inn["runs"] += wicket.runs_before_wicket
        inn["batsmen"][striker]["runs"] += wicket.runs_before_wicket
        if wicket.runs_before_wicket == 4:
            inn["batsmen"][striker]["fours"] += 1
        elif wicket.runs_before_wicket >= 6:
            inn["batsmen"][striker]["sixes"] += 1

    # Mark batsman as out
    inn["batsmen"][striker]["out"] = True
    inn["batsmen"][striker]["balls"] += 1
    inn["batsmen"][striker]["how_out"] = wicket.dismissal_type
    inn["batsmen"][striker]["status"] = "out"

    # Bowler gets credit (except run out, retired, obstructing, out of court)
    bowler_wicket = wicket.dismissal_type not in ["run_out", "retired", "retired_hurt", "obstructing", "out_of_court"]
    if bowler_wicket:
        inn["bowlers"][bowler]["wickets"] += 1
    inn["bowlers"][bowler]["balls"] += 1
    inn["bowlers"][bowler]["runs"] += wicket.runs_before_wicket
    inn["bowlers"][bowler]["over_runs"] += wicket.runs_before_wicket

    # Update totals
    inn["wickets"] += 1
    inn["balls"] += 1

    # Fall of wickets
    inn["fow"].append({
        "wickets": inn["wickets"],
        "runs": inn["runs"],
        "overs": get_overs_str(inn["balls"]),
        "batsman": striker,
        "how_out": wicket.dismissal_type,
    })

    # This over display
    inn["this_over"].append("W")

    # Update partnership
    inn["partnership"]["runs"] += wicket.runs_before_wicket
    inn["partnership"]["balls"] += 1

    # Determine who's at which end
    # Runs before wicket may have swapped strike
    swapped_from_runs = wicket.runs_before_wicket % 2 == 1
    is_last_man = wicket.new_batsman == "__last_man_standing__"

    if is_last_man:
        # Last man standing: remaining batsman keeps batting alone
        if swapped_from_runs:
            inn["striker"] = inn["non_striker"]
        # Non-striker position is empty (last man)
        inn["non_striker"] = None
    else:
        if swapped_from_runs:
            # Non-striker ran to striker's end
            inn["striker"] = inn["non_striker"]
            inn["non_striker"] = wicket.new_batsman
        else:
            # Striker was out at their end, new batsman replaces
            inn["striker"] = wicket.new_batsman

        # Init new batsman stats
        if wicket.new_batsman not in inn["batsmen"]:
            inn["batsmen"][wicket.new_batsman] = {
                "runs": 0, "balls": 0, "fours": 0, "sixes": 0,
                "out": False, "how_out": "", "status": "batting"
            }

    # Reset partnership for new pair
    inn["partnership"] = {"runs": 0, "balls": 0}

    event["swapped_from_runs"] = swapped_from_runs
    event["bowler_wicket"] = bowler_wicket
    inn["ball_log"].append(event)

    # Check over complete
    over_complete = inn["balls"] > 0 and inn["balls"] % 6 == 0
    if over_complete:
        if inn["bowlers"][bowler]["over_runs"] == 0:
            inn["bowlers"][bowler]["maidens"] += 1
        inn["bowlers"][bowler]["over_runs"] = 0
        if inn["non_striker"] is not None:
            inn["striker"], inn["non_striker"] = inn["non_striker"], inn["striker"]

    # Check innings complete
    innings_complete = check_innings_complete(inn)

    if innings_complete:
        if match_data["current_innings"] == 0:
            match_data["status"] = "innings_break"
        else:
            match_data["status"] = "completed"

    response = {
        "status": "ok",
        "match": match_data,
        "over_complete": over_complete,
        "innings_complete": innings_complete,
        "need_bowler": over_complete and not innings_complete,
    }

    if match_data["status"] == "completed":
        response["result"] = get_match_result()

    return response


@app.post("/api/select-bowler")
def select_bowler(selection: BowlerSelection):
    """Select bowler for the new over."""
    global match_data
    inn = get_current_innings()

    inn["current_bowler"] = selection.bowler
    inn["this_over"] = []

    if selection.bowler not in inn["bowlers"]:
        inn["bowlers"][selection.bowler] = {
            "balls": 0, "runs": 0, "wickets": 0, "maidens": 0,
            "wides": 0, "no_balls": 0, "over_runs": 0
        }
    else:
        inn["bowlers"][selection.bowler]["over_runs"] = 0

    return {"status": "ok", "match": match_data}


@app.post("/api/undo")
def undo_last_ball():
    """Undo the last recorded ball."""
    global match_data
    if not match_data:
        raise HTTPException(400, "No match")

    inn = get_current_innings()

    if not inn["ball_log"]:
        raise HTTPException(400, "Nothing to undo")

    event = inn["ball_log"].pop()

    # Remove from this_over
    if inn["this_over"]:
        inn["this_over"].pop()

    if event["type"] == "wicket":
        # Undo wicket
        dismissed = event["striker"]
        new_bat = event["new_batsman"]

        # Remove new batsman
        if new_bat in inn["batsmen"]:
            del inn["batsmen"][new_bat]

        # Restore dismissed batsman from snapshot
        inn["batsmen"][dismissed] = event["striker_stats_snapshot"]

        # Undo bowler stats
        bowler = event["bowler"]
        if event["bowler_wicket"]:
            inn["bowlers"][bowler]["wickets"] -= 1
        inn["bowlers"][bowler]["balls"] -= 1
        inn["bowlers"][bowler]["runs"] -= event["runs_before_wicket"]
        inn["bowlers"][bowler]["over_runs"] -= event["runs_before_wicket"]

        # Restore totals
        inn["runs"] = event["total_runs_before"]
        inn["balls"] = event["total_balls_before"]
        inn["wickets"] = event["total_wickets_before"]

        # Remove FOW
        if inn["fow"]:
            inn["fow"].pop()

        # Restore partnership
        inn["partnership"] = event["partnership_before"]

        # Restore positions
        inn["striker"] = event["striker"]
        inn["non_striker"] = event["non_striker"]
        inn["current_bowler"] = event["bowler"]

    else:
        # Undo normal ball
        striker = event["striker"]
        bowler = event["bowler"]
        extra_type = event["extra_type"]
        runs = event["runs"]
        extra_runs = event["extra_runs"]

        # Undo swap
        if event.get("swapped"):
            inn["striker"], inn["non_striker"] = inn["non_striker"], inn["striker"]

        # Restore totals from snapshot
        inn["runs"] = event["total_runs_before"]
        inn["balls"] = event["total_balls_before"]

        # Restore extras
        inn["extras"] = event["extras_before"]

        # Restore partnership
        inn["partnership"] = event["partnership_before"]

        # Undo batsman stats
        if extra_type == "none":
            inn["batsmen"][striker]["runs"] -= runs
            inn["batsmen"][striker]["balls"] -= 1
            if runs == 4:
                inn["batsmen"][striker]["fours"] -= 1
            elif runs >= 6:
                inn["batsmen"][striker]["sixes"] -= 1
            inn["bowlers"][bowler]["runs"] -= runs
            inn["bowlers"][bowler]["balls"] -= 1
            inn["bowlers"][bowler]["over_runs"] -= runs

        elif extra_type == "wide":
            total = 1 + extra_runs
            inn["bowlers"][bowler]["wides"] -= 1
            inn["bowlers"][bowler]["runs"] -= total
            inn["bowlers"][bowler]["over_runs"] -= total

        elif extra_type == "no_ball":
            total = 1 + runs + extra_runs
            inn["bowlers"][bowler]["no_balls"] -= 1
            inn["bowlers"][bowler]["runs"] -= total
            inn["bowlers"][bowler]["over_runs"] -= total
            if runs > 0:
                inn["batsmen"][striker]["runs"] -= runs
                if runs == 4:
                    inn["batsmen"][striker]["fours"] -= 1
                elif runs >= 6:
                    inn["batsmen"][striker]["sixes"] -= 1

        elif extra_type == "bye":
            inn["batsmen"][striker]["balls"] -= 1
            inn["bowlers"][bowler]["balls"] -= 1

        elif extra_type == "leg_bye":
            inn["batsmen"][striker]["balls"] -= 1
            inn["bowlers"][bowler]["balls"] -= 1

        # Restore positions
        inn["striker"] = event["striker"]
        inn["non_striker"] = event["non_striker"]
        inn["current_bowler"] = event["bowler"]

    # Restore match status if it was changed
    if match_data["status"] in ["completed", "innings_break"]:
        match_data["status"] = "batting"

    return {"status": "ok", "match": match_data}


@app.post("/api/swap-strike")
def swap_strike():
    """Manually swap striker and non-striker."""
    global match_data
    inn = get_current_innings()
    if inn["non_striker"] is not None:
        inn["striker"], inn["non_striker"] = inn["non_striker"], inn["striker"]
    return {"status": "ok", "match": match_data}


@app.post("/api/change-batsman")
def change_batsman(req: ChangeBatsman):
    """Change a batsman mid-match (substitute / last-minute swap)."""
    global match_data
    if not match_data or match_data["status"] != "batting":
        raise HTTPException(400, "Match not in batting state")

    inn = get_current_innings()

    if req.position == "striker":
        inn["striker"] = req.new_batsman
    elif req.position == "non_striker":
        inn["non_striker"] = req.new_batsman
    else:
        raise HTTPException(400, "Position must be 'striker' or 'non_striker'")

    # Init stats for new batsman if not already batted
    if req.new_batsman not in inn["batsmen"]:
        inn["batsmen"][req.new_batsman] = {
            "runs": 0, "balls": 0, "fours": 0, "sixes": 0,
            "out": False, "how_out": "", "status": "batting"
        }

    return {"status": "ok", "match": match_data}


@app.post("/api/change-bowler")
def change_bowler_mid_over(selection: BowlerSelection):
    """Change the bowler mid-over (substitute / last-minute swap)."""
    global match_data
    if not match_data or match_data["status"] != "batting":
        raise HTTPException(400, "Match not in batting state")

    inn = get_current_innings()
    inn["current_bowler"] = selection.bowler

    # Init stats for new bowler if not already bowled
    if selection.bowler not in inn["bowlers"]:
        inn["bowlers"][selection.bowler] = {
            "balls": 0, "runs": 0, "wickets": 0, "maidens": 0,
            "wides": 0, "no_balls": 0, "over_runs": 0
        }

    return {"status": "ok", "match": match_data}

@app.post("/api/end-innings")
def end_innings():
    """End the current innings early (declare/retire)."""
    global match_data
    if not match_data or match_data["status"] != "batting":
        raise HTTPException(400, "Match not in batting state")

    if match_data["current_innings"] == 0:
        match_data["status"] = "innings_break"
    else:
        match_data["status"] = "completed"

    response = {"status": "ok", "match": match_data}
    if match_data["status"] == "completed":
        response["result"] = get_match_result()
    return response



@app.post("/api/start-innings-2")
def start_second_innings():
    """Start the second innings."""
    global match_data
    if not match_data:
        raise HTTPException(400, "No match")

    target = match_data["innings"][0]["runs"] + 1

    match_data["innings"].append(
        create_innings(
            match_data["team2"]["name"], match_data["team1"]["name"],
            match_data["team2"]["players"], match_data["team1"]["players"],
            target=target
        )
    )
    match_data["current_innings"] = 1
    match_data["status"] = "setup"

    return {"status": "ok", "match": match_data}


@app.post("/api/reset")
def reset_match():
    """Reset the entire match."""
    global match_data
    match_data = None
    return {"status": "ok"}


@app.get("/api/players")
def get_players():
    """Return predefined player roster."""
    return {"players": PLAYER_ROSTER}


@app.post("/api/generate-teams")
async def generate_teams(req: Optional[GenerateTeamsRequest] = None):
    """Use OpenRouter API to generate balanced teams based on player ratings."""
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise HTTPException(status_code=400, detail="OPENROUTER_API_KEY environment variable is not set.")

    csv_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "player-details.csv")
    try:
        with open(csv_path, "r") as f:
            raw = f.read().strip().split("\n")

        header = raw[0]
        cols = [c.strip().lower() for c in header.split(",")]
        name_col = cols[0]

        # Parse each player row into a dict
        player_rows = []
        for line in raw[1:]:
            if not line.strip():
                continue
            parts = line.split(",")
            if len(parts) < 2:
                continue
            player_rows.append({cols[i]: parts[i].strip() for i in range(min(len(cols), len(parts)))})

        # Filter to only selected players (if provided)
        if req and req.available_players:
            available_lower = [p.lower() for p in req.available_players]
            player_rows = [r for r in player_rows if r.get(name_col, "").lower() in available_lower]

        if len(player_rows) < 2:
            raise HTTPException(status_code=400, detail="Not enough players selected.")

        # Compute total rating for each player (sum of all numeric columns)
        for row in player_rows:
            total = 0
            for k, v in row.items():
                if k == name_col:
                    continue
                try:
                    total += float(v)
                except ValueError:
                    pass
            row["_total"] = total

        # Deterministically pick the weakest player as common for odd rosters
        common_player = None
        pool = list(player_rows)
        if len(pool) % 2 == 1:
            weakest = min(pool, key=lambda r: r["_total"])
            common_player = weakest[name_col]
            pool = [r for r in pool if r[name_col] != common_player]

        # Build the CSV to send to the LLM (only the even pool)
        pool_csv_lines = [header]
        for row in pool:
            pool_csv_lines.append(",".join(row.get(c, "") for c in cols))
        pool_csv = "\n".join(pool_csv_lines)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not read player-details.csv: {e}")

    prompt = (
        "Here is a list of players with their batting, bowling, and fielding ratings.\n"
        f"```csv\n{pool_csv}\n```\n\n"
        "Divide these players into exactly two balanced teams (Team 1 and Team 2) "
        "such that the total overall skill of both teams is as close as possible. "
        "Every player must appear in exactly one team.\n"
        "Return ONLY a valid JSON object with keys 'team1' (list of player name strings) and 'team2' (list of player name strings). "
        "Do not include markdown, explanations, or any other text."
    )

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json"
                },
                json={
                    "model": "openai/gpt-4o-mini",
                    "messages": [{"role": "user", "content": prompt}]
                }
            )
            response.raise_for_status()
            data = response.json()
            content = data["choices"][0]["message"]["content"].strip()

            # Strip markdown wrappers if present
            if content.startswith("```json"):
                content = content[7:]
            elif content.startswith("```"):
                content = content[3:]
            if content.endswith("```"):
                content = content[:-3]

            teams = json.loads(content.strip())
            if "team1" not in teams or "team2" not in teams:
                raise ValueError("JSON response missing team1 or team2 keys.")

            team1 = teams["team1"]
            team2 = teams["team2"]

            # Append the common (weakest) player to both teams
            if common_player:
                team1.append(common_player)
                team2.append(common_player)

            return {
                "status": "ok",
                "team1": team1,
                "team2": team2,
                "common": common_player
            }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM generation failed: {str(e)}")


# ============================================================
# Serve Scoring Page
# ============================================================
@app.get("/scorer", response_class=HTMLResponse)
async def scorer_page():
    """Serve the scoring HTML page."""
    html_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates", "scorer.html")
    try:
        with open(html_path, "r") as f:
            content = f.read()
            return HTMLResponse(content=content, headers={"Cache-Control": "no-store, max-age=0"})
    except FileNotFoundError:
        return HTMLResponse(content="<h1>Scorer page not found. Check templates/scorer.html</h1>", status_code=404)


# ============================================================
# Gradio Auth — Entry Point
# ============================================================
with gr.Blocks(
    title="Cricket Scorer",
) as demo:
    gr.HTML("""
    <div style="
        text-align: center;
        padding: 60px 20px;
        font-family: system-ui, -apple-system, sans-serif;
        background: linear-gradient(135deg, #f0fdf4 0%, #ecfeff 100%);
        min-height: 80vh;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
    ">
        <div style="font-size: 4em; margin-bottom: 16px;">🏏</div>
        <h1 style="
            font-size: 2em;
            margin-bottom: 8px;
            color: #0f172a;
            font-weight: 700;
            letter-spacing: -0.5px;
        ">Cricket Scorer</h1>
        <p style="
            color: #64748b;
            margin-bottom: 40px;
            font-size: 1.1em;
        ">You're authenticated! Please enter the app to choose your action.</p>
        <a href="/scorer" style="
            display: inline-block;
            padding: 18px 48px;
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            color: white;
            text-decoration: none;
            border-radius: 14px;
            font-size: 1.2em;
            font-weight: 600;
            box-shadow: 0 4px 24px rgba(16, 185, 129, 0.3);
            transition: transform 0.15s, box-shadow 0.15s;
        " onmouseover="this.style.transform='scale(1.05)';this.style.boxShadow='0 6px 32px rgba(16,185,129,0.4)'"
           onmouseout="this.style.transform='scale(1)';this.style.boxShadow='0 4px 24px rgba(16,185,129,0.3)'"
        >Enter App / Home Screen &rarr;</a>
        <p style="
            color: #94a3b8;
            margin-top: 32px;
            font-size: 0.85em;
        ">Default login: scorer / cricket</p>
    </div>
    """)

# Mount Gradio at root
app = gr.mount_gradio_app(
    app,
    demo,
    path="/"
)


# ============================================================
# Run with uvicorn
# ============================================================
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
