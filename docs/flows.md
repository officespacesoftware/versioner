# Flows

Diagrams of the release lifecycle, the hotfix lifecycle, the plan/confirm protocol, the
downmerge decisions, the revert shape and the pipeline trigger. They summarise
[actions.md](actions.md), which is authoritative on detail; message IDs refer to
[messages.md](messages.md). GitHub renders the Mermaid blocks.

Deploying to production is not an action of these tools. It appears in the diagrams
because several steps must wait for it.

## Release lifecycle

```mermaid
flowchart TD
  DEV["develop at a final version, e.g. 1.3.0"]
  RC0["release/1.4.0 at 1.4.0-RC.0<br/>tag 1.4.0-RC.0<br/>PR release/1.4.0 → develop: RC 1.4.0-RC.0 to develop"]
  RCN["release/1.4.0 at 1.4.0-RC.n<br/>tag 1.4.0-RC.n<br/>same PR retitled RC 1.4.0-RC.n to develop"]
  FIN["release/1.4.0 at 1.4.0<br/>tag 1.4.0 and GitHub release 1.4.0<br/>PR release/1.4.0 → main: Release 1.4.0 to main<br/>PR release/1.4.0 → develop: Release 1.4.0 to develop"]
  DEP["1.4.0 deployed to production"]
  RM["merge branch release-1.4.0-into-main-ts<br/>PR → main: Release 1.4.0 to main<br/>PR release/1.4.0 → main closed as superseded"]
  MAIN["main at 1.4.0"]
  MD["merge branch main-into-develop-ts<br/>PR → develop: Release 1.4.0 to develop"]
  RD["PR release/1.4.0 → develop updated"]

  DEV -->|"create_release_candidate (refused unless main is in develop)"| RC0
  RC0 -->|"fixes pushed, increment_release_candidate"| RCN
  RCN -->|"more fixes, increment_release_candidate"| RCN
  RC0 -->|"release_version"| FIN
  RCN -->|"release_version"| FIN
  FIN -->|"outside these tools"| DEP
  DEP -->|"downmerge release → main"| RM
  RM -->|"PR merged after the deploy"| MAIN
  DEP -->|"downmerge release → develop"| RD
  MAIN -->|"downmerge main → develop"| MD
```

Each RC can be undone with `revert_version` (RC.n back to RC.n-1, a final back to its RC,
RC.0 abandons the branch); see [Revert shape](#revert-shape). `release_version` warns when
`main` holds commits the branch lacks or would conflict with it (W3, W4), and
`increment_release_candidate` and `release_version` warn when a shipped hotfix is missing
from the release branch (W1).

## Hotfix lifecycle

```mermaid
flowchart TD
  MAIN0["main at a final version, e.g. 1.4.0"]
  HF0["hotfix/1.4.1 at 1.4.1-RC.0<br/>tag 1.4.1-RC.0<br/>PR hotfix/1.4.1 → main: RC 1.4.1-RC.0 to main, with the production warning<br/>draft PR hotfix/1.4.1 → develop: Hotfix 1.4.1 to develop"]
  HFN["hotfix/1.4.1 at 1.4.1-RC.n<br/>tag 1.4.1-RC.n<br/>PR → main retitled RC 1.4.1-RC.n to main"]
  FIN["hotfix/1.4.1 at 1.4.1<br/>tag 1.4.1 and GitHub release 1.4.1<br/>PR → main retitled Release 1.4.1 to main<br/>draft PR → develop updated, or opened as a draft if closed"]
  DEP["1.4.1 deployed to production"]
  HM["PR hotfix/1.4.1 → main updated: Release 1.4.1 to main"]
  MAIN1["main at 1.4.1"]
  HD["merge branch hotfix-1.4.1-into-develop-ts<br/>PR → develop: Hotfix 1.4.1 to develop<br/>hotfix/1.4.1 → develop PR closed as superseded"]
  REL["release branch in flight, if any"]

  MAIN0 -->|"create_hotfix"| HF0
  HF0 -->|"fix pushed, increment_release_candidate"| HFN
  HFN -->|"increment_release_candidate"| HFN
  HF0 -->|"release_version"| FIN
  HFN -->|"release_version"| FIN
  FIN -->|"outside these tools"| DEP
  DEP -->|"downmerge hotfix → main"| HM
  HM -->|"PR merged after the deploy"| MAIN1
  DEP -->|"downmerge hotfix → develop"| HD
  MAIN1 -.->|"no downmerge route: open a PR into the release branch by hand"| REL
```

Once the hotfix is in `main`, `create_release_candidate`, `increment_release_candidate` and
`release_version` warn (W1) until it is also in `develop` or the release branch. There is
no downmerge route into a release branch.

## Plan and confirm

```mermaid
sequenceDiagram
  actor H as Human
  participant C as Agent or script
  participant T as MCP tool or CLI
  participant R as Repository and GitHub

  C->>T: call without confirm
  T->>R: preconditions, fetch origin into remote-tracking refs
  T->>R: branch selection, read-only facts, pre-version checks
  alt a refusal applies
    T-->>C: refusal, nothing changed
  else
    T-->>C: plan with warnings, notes and digest, nothing changed
    C->>H: present the plan and stop
    H->>C: approve by sending the digest
    C->>T: call again with confirm set to the digest
    T->>R: fetch again, rebuild the plan, run the checks again
    alt digest differs
      T-->>C: D1 refusal with the fresh plan and its digest
    else digest matches
      T->>R: on the refs just fetched: commit, tag, push, pull requests, release
      T->>R: pipeline trigger when the branch heads no open PR
      T-->>C: result, with any apply reports
    end
  end
```

The CLI's `--yes` skips the human step: it builds the plan, prints it to stderr, and
applies. `downmerge` and `initialize_versioner` never return a plan. What the digest covers
is in [actions.md](actions.md#what-the-digest-covers).

## Downmerge

```mermaid
flowchart TD
  START["downmerge source → target"] --> ROUTE{"one of the five routes?"}
  ROUTE -->|no| U6["U6 refusal"]
  ROUTE -->|yes| GUARD{"git repository, nothing staged?"}
  GUARD -->|no| G["G1 or G2 refusal"]
  GUARD -->|yes| FETCHO["fetch origin into remote-tracking refs"]
  FETCHO --> SRC{"source"}
  SRC -->|main| PREVIEW
  SRC -->|"release or hotfix"| SEL{"version given?"}
  SEL -->|yes| BYNAME["branch named release/version or hotfix/version<br/>none: S12"]
  SEL -->|no| NEWEST["highest-numbered branch of that type<br/>none: S13"]
  BYNAME --> PREVIEW
  NEWEST --> PREVIEW
  PREVIEW{"git merge-tree: source head into origin target"}
  PREVIEW -->|cannot compare| P13["P13 refusal"]
  PREVIEW -->|"conflicts, target develop"| H1["H1 Manual downmerge needed<br/>nothing created"]
  PREVIEW -->|"conflicts, target main"| H2["H2 Decision needed<br/>nothing created"]
  PREVIEW -->|clean| ANC{"source already in target?"}
  ANC -->|yes| P8["P8 refusal"]
  ANC -->|no| KIND{"route"}
  KIND -->|"main → develop, release → main, hotfix → develop"| MB["cut merge branch off origin/target,<br/>git merge --no-ff origin/source"]
  MB -->|conflict| HX["H1 or H2, local branch deleted"]
  MB -->|no new commit| A28["A28, nothing pushed"]
  MB -->|merged| PUSH["push merge branch, open PR into target"]
  PUSH -->|"hotfix → develop"| CLOSE["close the hotfix → develop PR as superseded"]
  PUSH -->|"release → main"| CLOSER["close the release → main PR as superseded"]
  KIND -->|"release → develop"| TRIAL["trial merge in the working tree, then abort"]
  TRIAL -->|conflict| H1B["H1"]
  TRIAL -->|clean| DPR["open or update release → develop PR"]
  KIND -->|"hotfix → main"| FETCH["preview again on the fetched refs"]
  FETCH -->|conflict| H2B["H2"]
  FETCH -->|clean| HPR["open or update hotfix → main PR"]
```

## Revert shape

```mermaid
flowchart TD
  SEL{"version given?"}
  SEL -->|yes| BYNAME["release/version or hotfix/version<br/>both: S8, neither: S9"]
  SEL -->|no| CUR["the checked-out branch<br/>not release or hotfix: S10"]
  BYNAME --> HEAD
  CUR --> HEAD
  HEAD{"head commit"}
  HEAD -->|"no readable VERSION"| P9["P9 refusal"]
  HEAD -->|"subject is not To version v"| P10["P10 refusal"]
  HEAD -->|"already in origin/main"| P11["P11 refusal"]
  HEAD -->|ok| PARENT{"parent's VERSION is another version of the same release?"}
  PARENT -->|yes| REVERT["revert shape<br/>git revert, delete tag, delete release if final,<br/>push, update PR, pipeline trigger"]
  PARENT -->|no| UNIQUE{"other commits not in the base?"}
  UNIQUE -->|yes| P12["P12 refusal"]
  UNIQUE -->|no| ABANDON["abandon shape, W13<br/>delete tag, delete release if final,<br/>close PR with comment, delete branch"]
```

## Pipeline trigger

```mermaid
flowchart TD
  PUSHED["versioning action pushed and finished its PR steps"] --> CFG{"pipeline section at the pushed commit?"}
  CFG -->|absent| NONE["nothing"]
  CFG -->|"present or invalid"| LOOKUP{"open PRs with this branch as head?"}
  LOOKUP -->|lookup failed| T5["failed T5"]
  LOOKUP -->|"one or more"| OPEN{"section valid?"}
  OPEN -->|yes| T3["skipped T3"]
  OPEN -->|no| NONE2["nothing"]
  LOOKUP -->|none| VALID{"section valid?"}
  VALID -->|no| T6["failed T6"]
  VALID -->|yes| RUN["run the trigger in a detached checkout"]
  RUN -->|exit 0| T2["started T2"]
  RUN -->|"non-zero, timeout, cannot start"| T789["failed T7, T8 or T9"]
```
