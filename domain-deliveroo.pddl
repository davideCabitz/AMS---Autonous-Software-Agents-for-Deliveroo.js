;; domain file: domain-deliveroo.pddl
;; Movement domain with Sokoban-style crate pushing (see lab5-APIsForPlanning).
;; The agent walks over free tiles, and may push a crate one tile ahead when the
;; tile beyond it is free and "pushable" (walkable, not a delivery/spawn tile).
;; Pushing costs more than a plain step so the planner only moves obstacles when
;; doing so opens a genuinely shorter route.
(define (domain default)
    (:requirements :strips)
    (:predicates
        (tile ?t)
        (delivery ?t)
        (agent ?a)
        (me ?a)
        (crate ?c)
        (at ?agentOrCrate ?tile)
        (free ?t)        ; tile currently has no crate on it
        (pushable ?t)    ; walkable tile a crate is allowed to be pushed onto (not delivery, not spawn)
        (right ?t1 ?t2)
        (left  ?t1 ?t2)
        (up    ?t1 ?t2)
        (down  ?t1 ?t2)
        (near ?t)        ; a candidate gather tile (within the mission distance, reachable, not the partner's)
        (gathered ?a)    ; ?a has reached some (near) tile — the gather mission goal
    )

    ;; ---- plain agent moves: step onto an adjacent free tile ----
    (:action right
        :parameters (?me ?from ?to)
        :precondition (and (me ?me) (at ?me ?from) (right ?from ?to) (free ?to))
        :effect       (and (at ?me ?to) (not (at ?me ?from)))
    )

    (:action left
        :parameters (?me ?from ?to)
        :precondition (and (me ?me) (at ?me ?from) (left ?from ?to) (free ?to))
        :effect       (and (at ?me ?to) (not (at ?me ?from)))
    )

    (:action up
        :parameters (?me ?from ?to)
        :precondition (and (me ?me) (at ?me ?from) (up ?from ?to) (free ?to))
        :effect       (and (at ?me ?to) (not (at ?me ?from)))
    )

    (:action down
        :parameters (?me ?from ?to)
        :precondition (and (me ?me) (at ?me ?from) (down ?from ?to) (free ?to))
        :effect       (and (at ?me ?to) (not (at ?me ?from)))
    )

    ;; ---- gather mission: commit once standing on ANY candidate (near) tile ----
    ;; Lets the planner CHOOSE which near tile to reach (shortest plan wins) instead of
    ;; JS pre-picking one. The existential "some near tile" is absorbed into this action's
    ;; precondition, so the goal stays a plain (gathered me) — no quantified goal needed
    ;; (the STRIPS backend does not support those). A no-op at execution time.
    (:action reachGatherSpot
        :parameters (?me ?t)
        :precondition (and (me ?me) (at ?me ?t) (near ?t))
        :effect       (gathered ?me)
    )

    ;; ---- push a crate one tile ahead; the agent follows into the crate's old tile ----
    (:action pushRight
        :parameters (?me ?crate ?myPos ?cratePos ?destPos)
        :precondition (and
            (me ?me) (crate ?crate)
            (at ?me ?myPos) (at ?crate ?cratePos)
            (right ?myPos ?cratePos) (right ?cratePos ?destPos)
            (free ?destPos) (pushable ?destPos)
        )
        :effect (and
            (at ?me ?cratePos) (not (at ?me ?myPos))
            (at ?crate ?destPos) (not (at ?crate ?cratePos))
            (free ?cratePos) (not (free ?destPos))
        )
    )

    (:action pushLeft
        :parameters (?me ?crate ?myPos ?cratePos ?destPos)
        :precondition (and
            (me ?me) (crate ?crate)
            (at ?me ?myPos) (at ?crate ?cratePos)
            (left ?myPos ?cratePos) (left ?cratePos ?destPos)
            (free ?destPos) (pushable ?destPos)
        )
        :effect (and
            (at ?me ?cratePos) (not (at ?me ?myPos))
            (at ?crate ?destPos) (not (at ?crate ?cratePos))
            (free ?cratePos) (not (free ?destPos))
        )
    )

    (:action pushUp
        :parameters (?me ?crate ?myPos ?cratePos ?destPos)
        :precondition (and
            (me ?me) (crate ?crate)
            (at ?me ?myPos) (at ?crate ?cratePos)
            (up ?myPos ?cratePos) (up ?cratePos ?destPos)
            (free ?destPos) (pushable ?destPos)
        )
        :effect (and
            (at ?me ?cratePos) (not (at ?me ?myPos))
            (at ?crate ?destPos) (not (at ?crate ?cratePos))
            (free ?cratePos) (not (free ?destPos))
        )
    )

    (:action pushDown
        :parameters (?me ?crate ?myPos ?cratePos ?destPos)
        :precondition (and
            (me ?me) (crate ?crate)
            (at ?me ?myPos) (at ?crate ?cratePos)
            (down ?myPos ?cratePos) (down ?cratePos ?destPos)
            (free ?destPos) (pushable ?destPos)
        )
        :effect (and
            (at ?me ?cratePos) (not (at ?me ?myPos))
            (at ?crate ?destPos) (not (at ?crate ?cratePos))
            (free ?cratePos) (not (free ?destPos))
        )
    )
)
