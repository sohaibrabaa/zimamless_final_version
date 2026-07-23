"""Trains the risk model and writes the artifact.

    py -m tools.train_risk_model                 # train and write
    py -m tools.train_risk_model --check         # verify the committed file

`--check` exists for the same reason it exists on `generate_einvoices.py`: a
"deterministic" pipeline that nobody re-runs is a claim, not a property. CI
runs the trainer and asserts the artifact it produces is byte-identical to the
one in git. If training ever stops being reproducible — a numpy upgrade
changing a reduction order, someone adding a random shuffle — the build fails
instead of the model quietly drifting away from its recorded metrics.

The model version label encodes the seed and the trainer version so that a
`risk_model_versions` row in the database can be traced to the exact artifact
that produced it.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.risk import synthetic  # noqa: E402
from app.risk.model import ARTIFACT_PATH, TRAINER_VERSION, train  # noqa: E402


def build(samples: int, seed: int) -> str:
    X, y = synthetic.generate(n=samples, seed=seed)
    model = train(X, y, version=f"{TRAINER_VERSION}+seed{seed}", seed=seed)
    return model.to_json()


def main() -> int:
    parser = argparse.ArgumentParser(description="Train the Zimmamless risk model.")
    parser.add_argument("--samples", type=int, default=6000)
    parser.add_argument("--seed", type=int, default=synthetic.DEFAULT_SEED)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Verify the committed artifact matches a fresh training run.",
    )
    args = parser.parse_args()

    produced = build(args.samples, args.seed)

    if args.check:
        if not ARTIFACT_PATH.exists():
            print(f"MISSING  {ARTIFACT_PATH.name} — run the trainer first.")
            return 1
        current = ARTIFACT_PATH.read_text(encoding="utf-8")
        if current != produced:
            print(
                f"DRIFT    {ARTIFACT_PATH.name} differs from a fresh training run.\n"
                "         Training is no longer reproducible, or the artifact was "
                "hand-edited.\n"
                "         Re-run without --check to regenerate, and explain the change."
            )
            return 1
        print(f"OK       {ARTIFACT_PATH.name} reproduces exactly.")
        return 0

    # newline="\n" explicitly: the default translates to os.linesep, so the
    # same training run would emit CRLF on Windows and LF elsewhere. The
    # repo's .gitattributes normalises to LF on commit, so without this the
    # working copy and the committed file differ on Windows the moment the
    # trainer runs — noise on every `git status` for a file whose whole point
    # is being byte-stable. (`--check` was never affected: read_text
    # normalises newlines on the way in.)
    ARTIFACT_PATH.write_text(produced, encoding="utf-8", newline="\n")
    print(f"WROTE    {ARTIFACT_PATH}")

    # Echo the metrics so a training run leaves a record in the terminal the
    # operator is already looking at, not only in a file they have to open.
    import json

    metrics = json.loads(produced)["metrics"]
    for key in ("samples", "positive_rate", "accuracy", "auc", "brier", "log_loss"):
        print(f"  {key:<16} {metrics[key]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
