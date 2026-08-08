# Shape of AI - UX Pattern Reference

**Source:** [shapeof.ai](https://shapeof.ai) by Emily Campbell  
**License:** CC-BY-NC-SA  
**Date Captured:** December 2024

A comprehensive reference of AI UX patterns relevant to AgentPod's generative UI implementation.

---

## Pattern Categories Overview

Shape of AI organizes patterns into **6 categories**:

| Category | Purpose | Pattern Count |
|----------|---------|---------------|
| **Wayfinders** | Help users construct their first prompt and get started | 8 |
| **Prompt Actions** | Different actions users can direct AI to complete | 13 |
| **Tuners** | Adjust contextual data and input details to refine prompts | 10 |
| **Governors** | Human-in-the-loop features for oversight and agency | 13 |
| **Trust Builders** | Give users confidence in AI accuracy and ethics | 7 |
| **Identifiers** | Distinct qualities of AI at brand/model level | 5 |

---

## Category 1: Wayfinders

> Help users construct their first prompt and get started.

### 1.1 Initial CTA
**Large, open-ended input inviting the user to start their first interaction.**

**Key Insights:**
- The blank canvas problem: "What is the likelihood that five words are enough to describe your creative vision?"
- Direct input has become default, but most people don't know how to phrase what they want
- Solution: Keep input box at center but surround with **supportive scaffolding**

**Scaffolding Types:**
- **Suggestions**: Common prompts surfaced near input
- **Galleries**: Example outputs showing range and possibility
- **Prompt enhancers**: Reformat user input for better AI results
- **Modes/selectors**: Switch between query types
- **Attachments**: Drop files for richer context
- **Templates**: Pre-built entry points

**CTA Variants:**
- **Action-first CTA**: AI as feature alongside traditional options (Typeform)
- **Contextual CTA**: AI introduced after data exists (Otter - after transcript)
- **Playful CTA**: Lower bar with humor/randomness (Udio)

**Design Considerations:**
- Make first step forgiving - scaffold short prompts with examples
- Spend compute wisely - structure input to reduce guessing
- Show range before depth
- Balance novelty and clarity

---

### 1.2 Suggestions
**Solves the blank canvas dilemma with clues for how to prompt.**

**Forms of Suggestions:**
- **Static**: Fixed starters for onboarding (product features)
- **Contextual**: Shift based on page/document content
- **Adaptive**: Evolve from user behavior over time

**Design Considerations:**
- Make suggestions actionable (clicking runs the prompt)
- Leverage contextual clues (attachments, mode changes)
- Scope when suggestions appear (don't show everywhere)
- Keep set small and ranked (3-6 options)
- Design for first-run learning
- Respect safety and cost

---

### 1.3 Follow Up
**Get more information when initial prompt isn't sufficiently clear.**

**Use Cases:**
- **Open conversation**: Probe deeper into user interests
- **Compute-heavy tasks**: Ensure understanding before expensive generation
- **Action-oriented flows**: Nudges and inline actions

**Variations:**
- Conversation extenders
- Clarifying questions
- Depth probes
- Comparisons
- Action nudges
- Share/Export options

**Design Considerations:**
- Anchor follow ups in what just happened
- Show why you're suggesting something
- Keep list short and scannable
- Balance depth and breadth
- Preserve conversational rhythm
- Let users select/regenerate options

---

### 1.4 Templates
**Structured templates that can be filled by user or pre-filled by AI.**

**Purpose:**
- Make complex prompts easy to construct
- Users don't have to describe everything (set parameters, fill key info)
- Blend of parameters, suggested prompts, and text inputs

**Design Considerations:**
- Minimize manual work (use variables, @-mentioning)
- Chain templates together for workflows
- Keep references to source

---

### 1.5 Example Gallery
**Share sample generations, prompts, and parameters to educate and inspire.**

**Gallery Types:**
- **Curated**: Hand-selected by platform team
- **Community**: User submissions with voting/trending
- **Dynamic**: Algorithmically surfaced based on context

**Common Traits:**
- Clear previews (thumbnails, clips)
- Structured organization (categories, tags, filters)
- Actionable examples ("start from here", remix)
- Varied samples (polished + everyday)
- Attribution and context

**Design Considerations:**
- Make browsing easy with search/filters
- Use metadata as teaching material
- Reflect product's strengths
- Balance curation and community
- Maintain freshness
- Use gallery as onboarding

---

### 1.6 Other Wayfinders
- **Nudges**: Alert users to AI actions they can take
- **Prompt Details**: Show what's happening behind the scenes
- **Randomize**: Kickstart with low bar and fun results

---

## Category 2: Prompt Actions (Inputs)

> Different actions that users can direct AI to complete.

### 2.1 Open Input
Open-ended prompt inputs for natural language prompting.

### 2.2 Inline Action
**Ask or interact with AI contextually based on something on the page.**

**Common Actions:**
- Suggested prompts opening new discussion
- Restructuring actions (rewrite, reframe)
- Restyling actions (tone, aesthetic)
- Transformational actions (change modality)

**Multi-modality:** Not limited to text - can apply to images, audio, live conversations.

**Design Considerations:**
- Offer concise, high-value defaults (shorten, expand, summarize)
- Rely on context to make actions relevant
- Enable granular selection and scoping
- Preview before commit
- Surface reasoning when stakes are high

---

### 2.3 Regenerate
Have AI reproduce response without additional input.

### 2.4 Transform
Change the modality of content.

### 2.5 Other Actions
- **Auto-fill**: Extend prompt to multiple fields
- **Chained Action**: Sequential AI operations
- **Describe**: Decompose into fundamental tokens
- **Expand**: Add depth and details
- **Inpainting**: Target specific areas to regenerate
- **Madlibs**: Repeated tasks with format consistency
- **Restructure**: Use existing content as starting point
- **Restyle**: Transfer styles without changing structure
- **Summary**: Distill to essence
- **Synthesis**: Reorganize complex info into simple structure

---

## Category 3: Tuners

> Adjust contextual data, token weights, and input details to refine the prompt.

### 3.1 Attachments
**Give AI specific reference to anchor its response.**

**Attachment Methods:**
- **Direct upload**: File, connection, @-mention
- **Inline action**: Text selection, overlay menus
- **URL embed**: Paste link, AI fetches page
- **Canvas block**: Pointer to select div/node
- **Live capture**: Screenshot, photo, audio clip

**Two Uses:**
1. **Style guide**: Convey intent without user detailing in full
2. **Primary source**: Focus AI on attachment contents

**Design Considerations:**
- Allow attachments at any time
- Use multiple input methods
- Let users give attachments a purpose
- Provide citations when referencing files
- Protect organizational data

---

### 3.2 Modes
**Adjust underlying training, constraints, and persona to specific context.**

**Types of Modes:**
- Open conversation (default)
- Deep research
- Study/tutor mode
- Copilot (canvas/IDE collaboration)
- Build vs. chat
- Creative modes
- Agentive/operator mode
- Specialized domains

**Effects of Changing Modes:**
- Model behavior (context length, reasoning depth)
- Output type
- Feature set
- Cost and performance
- User expectations

**Design Considerations:**
- Treat mode as contract, not theme
- Design explicit entry and exit paths
- Reconfigure surface when mode changes
- Set inheritance rules and stick to them
- Balance defaults, routing, and manual control
- Make modes discoverable with guardrails for costly states

---

### 3.3 Other Tuners
- **Connectors**: Reference external data
- **Filters**: Constrain inputs/outputs by source, type
- **Model Management**: Specify which model to use
- **Parameters**: Include constraints for generation
- **Preset Styles**: Default aesthetic/tone options
- **Prompt Enhancer**: Improve user prompts
- **Saved Styles**: User-defined presets
- **Voice and Tone**: Match outputs to preferences

---

## Category 4: Governors

> Human-in-the-loop features to maintain user oversight and agency.

### 4.1 Action Plan
**Show steps AI will take before execution.**

**Two Modes:**
- **Advisory**: AI uses plan for reasoning, shares in stream of thought
- **Contractual**: Requires user verification before proceeding

**Variations:**
- Step lists (linear outlines)
- Execution previews (code/automation approval)
- Content outlines (document scaffolds)
- Adaptive plans (evolve mid-process)

**Design Considerations:**
- Show plan before committing resources
- Keep plan skimmable
- Make plans modifiable
- Let users collapse or bypass plans
- Ensure fidelity between plan and execution

---

### 4.2 Stream of Thought
**Reveals AI's logic, tool use, and decisions for oversight.**

**What It Shows:**
- Human-readable plans
- Execution logs (tool calls, code, results)
- Compact summaries (reasoning, insights, decisions)

**Design Considerations:**
- Show plan before you act
- Separate plan, execution, and evidence
- Tailor visibility to context
- Make steps into states (queued, running, waiting, error, completed)
- Respect modality rules

---

### 4.3 Verification
**Allow users to confirm AI decisions before proceeding.**

**When to Require:**
- Loss of reputation (poorly written content)
- Loss of money (errant purchase)
- Loss of security (sharing data)
- Loss of work (overwritten records)
- Loss of time (cleanup errors)

**Types:**
- Simple go/no-go decisions
- Proactive platform rules (halt on sensitive data)
- User overrides (settings/instructions)

**Design Considerations:**
- Match friction to risk
- Use opt-out settings for control
- Make clear if verification is skipped
- Alert user when action is needed

---

### 4.4 Controls
**Manage flow of information or pause request mid-stream.**

**Common Controls:**
- **Stop button**: End request mid-generation
- **Pause button**: Stop without losing progress
- **Fast-forward**: Skip ahead in longer responses
- **Play**: Start new task
- **Queue**: Stack tasks for AI to complete

**Design Considerations:**
- Stop runs in a click
- Provide graceful pause and resume
- Let users act in flow of work
- Use variations instead of overwriting

---

### 4.5 Shared Vision
**Live visibility into AI's actions in shared canvas/workspace.**

**Examples:**
- Perplexity Comet: Glow when AI is active in tab
- OpenAI Operator: Browser view with real-time updates

**Design Considerations:**
- Ensure friction is warranted
- Don't let users confuse oversight with full security
- Let users constrain scope of control
- Signal boundaries visually
- Design for oversight in reverse (screenshots, details)

---

### 4.6 Other Governors
- **Branches**: Multiple paths without losing original
- **Citations**: Inline annotations citing sources
- **Cost Estimates**: Transparent cost for actions
- **Draft Mode**: Reduce costs until final form ready
- **Memory**: Control what AI knows about you
- **References**: See/manage additional sources
- **Sample Response**: Confirm intent for complicated prompts
- **Variations**: Compare multiple results

---

## Category 5: Trust Builders

> Give users confidence that AI's results are ethical, accurate, and trustworthy.

### 5.1 Footprints
**Visible traces showing where/how AI participated.**

**Modes of Use:**
- **Generative**: Trails for branching, replaying, reusing
- **Verifying**: Expose processing, sources, steps

**Where They Appear:**
- Interface (badges, markers, panels)
- System (logs, metadata)
- Media (watermarks, edit histories)

**Practical Uses:**
- Review logic (GitHub Copilot annotations)
- Content credentials (Adobe metadata)
- Replicating creative steps (Midjourney prompts)
- Verifying information (Perplexity citations)
- Improving data connections (Intercom reporting)

**Design Considerations:**
- Consider footprints at interface and system level
- Make footprints discoverable and consistent
- Support branching and replay
- Protect sensitive footprints
- Treat footprints as first-class data

---

### 5.2 Other Trust Builders
- **Caveat**: Inform about shortcomings/risks
- **Consent**: Capture data only with permission
- **Data Ownership**: Control how model uses your data
- **Disclosure**: Mark AI-guided content
- **Incognito Mode**: Interact outside AI's memory
- **Watermark**: Identifiers on AI content

---

## Category 6: Identifiers

> Distinct qualities of AI that can be modified at brand/model level.

- **Avatar**: Visual identifier of AI
- **Color**: Visual cues for AI features
- **Iconography**: Images representing AI actions
- **Name**: How AI is referred to
- **Personality**: Characteristics distinguishing AI's vibe

---

## Pattern Mapping to AgentPod

### High-Priority Patterns for Generative UI

| Pattern | AgentPod Application | Priority |
|---------|---------------------|----------|
| **Initial CTA** | "What's on your mind?" home page | P1 |
| **Suggestions** | Quick actions, contextual suggestions | P1 |
| **Modes** | Chat vs. Build vs. Review | P1 |
| **Stream of Thought** | Tool call visibility, progress | P1 |
| **Verification** | Permission requests | P1 |
| **Controls** | Stop/pause/resume session | P1 |
| **Action Plan** | Session planning (optional) | P2 |
| **Follow Up** | Next step suggestions | P2 |
| **Inline Action** | File/code context actions | P2 |
| **Attachments** | @ file mentions | P2 |
| **Shared Vision** | Live session monitoring | P2 |
| **Footprints** | Activity history, audit trail | P2 |
| **Memory** | Project/user preferences | P3 |
| **Branches** | Session branching | P3 |
| **Variations** | Multiple AI responses | P3 |

### Pattern Implementation Notes

**Initial CTA + Suggestions:**
```
┌─────────────────────────────────────────┐
│                                         │
│     What's on your mind?                │
│                                         │
│     [___________________________]       │
│                                         │
│     💡 Show my projects                 │
│     🚀 Start a session in X             │
│     📊 What needs attention?            │
│     ⚙️ Open settings                    │
│                                         │
└─────────────────────────────────────────┘
```

**Stream of Thought (Tool Calls):**
```
┌─────────────────────────────────────────┐
│ 🔄 Reading file...                      │
│    └─ src/lib/api.ts                    │
│                                         │
│ ✅ Edited file                          │
│    └─ src/lib/api.ts (+15, -3)          │
│                                         │
│ 🔄 Running tests...                     │
│    └─ npm test                          │
└─────────────────────────────────────────┘
```

**Verification (Permissions):**
```
┌─────────────────────────────────────────┐
│ 🔒 Permission Required                  │
│                                         │
│ AI wants to edit:                       │
│ src/lib/components/Button.tsx           │
│                                         │
│ [Allow Once] [Always Allow] [Reject]    │
└─────────────────────────────────────────┘
```

---

## Key Design Principles (Synthesized)

### 1. Progressive Disclosure
- Don't overwhelm with all options at once
- Scaffold short prompts with examples
- Show range before depth

### 2. Context is King
- Leverage contextual clues (attachments, page content, history)
- Adaptive suggestions based on user behavior
- Anchor follow ups in what just happened

### 3. Transparent Autonomy
- Show the plan before committing resources
- Make steps into states (queued, running, completed, error)
- Separate plan, execution, and evidence

### 4. Meaningful Controls
- Stop runs in a click
- Graceful pause and resume
- Match friction to risk

### 5. Trust Through Visibility
- Surface footprints and citations
- Mark the moment of capture
- Support branching and replay

### 6. Treat AI as Contract
- Mode changes set expectations
- Ensure fidelity between plan and execution
- Make clear if verification is skipped

---

*Reference compiled from shapeof.ai, December 2024*
