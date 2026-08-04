# Future Architecture

## Purpose

This document records architectural ideas intentionally postponed for future versions of the AISpec Engine.

The goal is to preserve long-term direction without increasing the complexity of the initial implementation.

Everything described here is optional and should only be implemented when it provides clear value.

---

# Current Engine Architecture

The first implementation of the AISpec Engine follows this pipeline:

```text
YAML / JSON

↓

Parser

↓

AISpecProject

↓

Validator

↓

Planner

↓

Runtime
```

`AISpecProject` is the canonical internal representation (IR) of the engine.

Every internal module communicates using this model.

---

# Architectural Principle

The Engine is intentionally designed so that future internal improvements do not require changes to the Validator, Planner, Runtime, SDKs, or CLI.

Only the Parser should be responsible for translating external representations into the internal model.

---

# Possible Future Evolution

If future versions require more advanced language features, the parsing stage may evolve into:

```text
YAML / JSON

↓

Parser

↓

Abstract Syntax Tree (AST)

↓

AISpecProject

↓

Validator

↓

Planner

↓

Runtime
```

The introduction of an AST must remain transparent to the rest of the Engine.

---

# Why an AST Is Not Included Today

The current version of AISpec does not require:

* compile-time optimizations;
* macro expansion;
* language transformations;
* advanced semantic analysis;
* multiple language syntaxes.

Adding an AST today would increase implementation complexity without providing proportional benefits.

The current architecture is intentionally simple.

---

# Design Goal

Future architectural improvements should satisfy the following rule:

Existing implementations must continue working without modification.

Backward compatibility has priority over architectural elegance.

---

# Long-Term Vision

AISpec is defined as an open Domain-Specific Language (DSL).

Today, YAML and JSON are supported serialization formats.

Future representations may include:

* TOML
* Binary encoding
* Visual editors
* Other serialization formats

Regardless of representation, every project must ultimately become an `AISpecProject`.

---

# Migration Strategy

If an AST is introduced in the future:

* the public Specification remains unchanged;
* the CLI remains unchanged;
* SDKs remain unchanged;
* the Runtime remains unchanged.

Only the Parser gains an additional internal stage.

---

# Final Principle

Architectural decisions should only be implemented when they solve real problems.

AISpec prefers incremental evolution over speculative complexity.

The simplest architecture that satisfies current requirements should always be preferred.
