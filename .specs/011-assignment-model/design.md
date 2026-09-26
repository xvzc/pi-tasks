# Design

## Overview

`Task.assignment` is a discriminated union. Store parsing owns structural validation. A delegated assignment requires a non-empty owner string, but pi-tasks treats that value as opaque planning metadata. Tool handlers and exported store mutations do not resolve owners.

## Ownership Boundary

Runtime agent discovery, agent availability, and owner guidance belong to the subagent extension. Pi-tasks does not read agent directories or subagent settings and does not mirror a live registry. This removes cross-extension parser and registry drift while preserving the assignment data contract.

## Mutation Boundary

`create`, `createMany`, `update`, and `updateMany` validate only assignment structure. Newly supplied delegated assignments retain the exact owner string. Direct assignments, `assignment: null`, omitted assignments, persisted hydration, and unrelated updates continue to use their existing behavior. Structural validation occurs before persistence, and batch failures remain atomic.

## Persistence

The persisted-task parser accepts only `assignment`; an `assignee` field fails key validation before entering the store. Clone/write paths deep-copy assignment and produce structurally reloadable active and historical records.
