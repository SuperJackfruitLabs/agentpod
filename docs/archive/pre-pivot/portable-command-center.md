1. [ ] # Project: Portable Command Center
2. [ ] 
3. [ ] A bespoke mobile application that acts as a "remote control" for an AI coding agent (OpenCode) running on a remote server. The heavy processing stays on the server; the phone provides a fast, native-feeling interface.
4. [ ] 
5. [ ] ---
6. [ ] 
7. [ ] ## Table of Contents
8. [ ] 
9. [ ] - [Vision](#vision)
10. [ ] - [Infrastructure Overview](#infrastructure-overview)
11. [ ] - [Architecture](#architecture)
12. [ ] - [Core Components](#core-components)
13. [ ] - [Technology Stack](#technology-stack)
14. [ ] - [Implementation Phases](#implementation-phases)
15. [ ] - [Resources](#resources)
16. [ ] 
17. [ ] ---
18. [ ] 
19. [ ] ## Vision
20. [ ] 
21. [ ] ### The Concept
22. [ ] 
23. [ ] You are building a **"Virtual Office"** — a one-person company powered by AI agents. The core idea:
24. [ ] 
25. [ ] - **The Brain is Remote**: Heavy "thinking," coding, and data processing run on your Hetzner VPS. This ensures your AI has maximum resources without draining your phone's battery.
26. [ ] - **The Interface is Local**: Your mobile phone runs a lightweight, high-performance app that connects to your server via Tailscale. This app handles the visuals and user input.
27. [ ] - **The "Native" Experience**: Even though the content is web-based, the app is designed to feel indistinguishable from a high-end, native mobile application — smooth animations, clean layout, and intuitive touch controls.
28. [ ] - **Full Version Control**: All project files live in Forgejo (self-hosted Git), providing complete version history, collaboration capabilities, and the ability to sync with GitHub/GitLab.
29. [ ] 
30. [ ] ### Why OpenCode?
31. [ ] 
32. [ ] [OpenCode](https://opencode.ai) (by SST) is the intelligence layer:
33. [ ] 
34. [ ] 1. **Client/Server Architecture** — Designed to run the "Brain" on a server and stream to a client. Perfect for mobile.
35. [ ] 2. **Vendor Neutrality** — 100% open source. Plug in any AI model (Claude, GPT, GitHub Copilot, local via Ollama).
36. [ ] 3. **Agentic by Default** — Not just autocomplete; it plans and executes multi-step tasks autonomously.
37. [ ] 4. **75+ LLM Providers** — Support for virtually any LLM provider with flexible authentication.
38. [ ] 
39. [ ] ---
40. [ ] 
41. [ ] ## Infrastructure Overview
42. [ ] 
43. [ ] ### Your Resources
44. [ ] 
45. [ ] | Device | Role | Connection | Workload |
46. [ ] |--------|------|------------|----------|
47. [ ] | **Hetzner VPS** | Primary server | Tailscale + Public IP | Coolify, Forgejo, Management API, OpenCode containers |
48. [ ] | **Mobile** | Client | Tailscale | Portable Command Center app |
49. [ ] 
50. [ ] ### Network Topology
51. [ ] 
52. [ ] All devices connected via **Tailscale** mesh VPN:
53. [ ] - Zero-trust security (no public port exposure needed)
54. [ ] - Encrypted connections between all devices
55. [ ] - Works behind NAT, firewalls, anywhere
56. [ ] - Each device gets a stable 100.x.x.x IP
57. [ ] 
58. [ ] ---
59. [ ] 
60. [ ] ## Architecture
61. [ ] 
62. [ ] ```mermaid
63. [ ] graph TB
64. [ ]     subgraph TAILSCALE["Tailscale Network (100.x.x.x)"]
65. [ ]         subgraph VPS["Hetzner VPS"]
66. [ ]             COOLIFY["Coolify<br/>Container Orchestration<br/>Traefik Proxy"]
67. [ ]             FORGEJO["Forgejo<br/>Git Repos<br/>GitHub Sync"]
68. [ ]             MGMT["Management API<br/>Project Lifecycle<br/>Credentials"]
69. [ ]             
70. [ ]             subgraph CONTAINERS["OpenCode Containers"]
71. [ ]                 OC1["Project A"]
72. [ ]                 OC2["Project B"]
73. [ ]                 OC3["Project C"]
74. [ ]             end
75. [ ]         end
76. [ ]         
77. [ ]         subgraph MOBILE["Mobile App (Tauri + Svelte)"]
78. [ ]             RUST["Rust Backend<br/>OAuth Proxy<br/>API Client"]
79. [ ]             SVELTE["Svelte Frontend<br/>Project List<br/>Chat UI"]
80. [ ]         end
81. [ ]     end
82. [ ]     
83. [ ]     MOBILE -->|"REST + SSE"| MGMT
84. [ ]     MOBILE -->|"REST + SSE"| CONTAINERS
85. [ ]     MGMT -->|"API"| COOLIFY
86. [ ]     MGMT -->|"API"| FORGEJO
87. [ ]     COOLIFY -->|"Manages"| CONTAINERS
88. [ ]     FORGEJO -->|"Git Clone"| CONTAINERS
89. [ ] ```
90. [ ] 
91. [ ] ### Component Relationships
92. [ ] 
93. [ ] ```mermaid
94. [ ] flowchart LR
95. [ ]     subgraph External["External Services"]
96. [ ]         GH["GitHub/GitLab"]
97. [ ]         LLM["LLM Providers<br/>(OpenAI, Anthropic, etc.)"]
98. [ ]     end
99. [ ]     
100. [ ]     subgraph Server["Hetzner VPS"]
101. [ ]         FG["Forgejo"]
102. [ ]         MA["Management API"]
103. [ ]         CL["Coolify"]
104. [ ]         OC["OpenCode"]
105. [ ]     end
106. [ ]     
107. [ ]     subgraph Client["Mobile"]
108. [ ]         APP["Tauri App"]
109. [ ]     end
110. [ ]     
111. [ ]     GH <-->|"Sync"| FG
112. [ ]     APP -->|"Commands"| MA
113. [ ]     APP -->|"Chat"| OC
114. [ ]     MA -->|"Containers"| CL
115. [ ]     MA -->|"Repos"| FG
116. [ ]     OC -->|"Code"| FG
117. [ ]     OC -->|"Inference"| LLM
118. [ ] ```
119. [ ] 
120. [ ] ---
121. [ ] 
122. [ ] ## Core Components
123. [ ] 
124. [ ] ### 1. Coolify (Container Orchestration)
125. [ ] 
126. [ ] Self-hosted PaaS that manages Docker containers on the VPS.
127. [ ] 
128. [ ] **Key Capabilities:**
129. [ ] - Deploy Docker images
130. [ ] - Environment variable management (stores LLM credentials)
131. [ ] - Automatic SSL via Traefik
132. [ ] - REST API for programmatic control
133. [ ] 
134. [ ] **API Endpoints Used:**
135. [ ] | Operation | Endpoint | Purpose |
136. [ ] |-----------|----------|---------|
137. [ ] | Create App | `POST /applications/dockerimage` | Spin up new OpenCode container |
138. [ ] | Set Env Vars | `POST /applications/:uuid/envs` | Configure LLM API keys |
139. [ ] | Start/Stop | `GET /applications/:uuid/start\|stop` | Control containers |
140. [ ] 
141. [ ] ### 2. Forgejo (Git Forge)
142. [ ] 
143. [ ] Self-hosted Git forge for all project files.
144. [ ] 
145. [ ] **Key Capabilities:**
146. [ ] - Full Git version control
147. [ ] - Web UI for browsing code
148. [ ] - API for repo management
149. [ ] - GitHub/GitLab mirroring
150. [ ] 
151. [ ] **Workflows:**
152. [ ] - **New project from scratch**: Create empty Forgejo repo
153. [ ] - **Import from GitHub/GitLab**: Clone external repo into Forgejo
154. [ ] - **Sync back to GitHub**: Push changes after OpenCode updates
155. [ ] 
156. [ ] ### 3. Management API (Custom Service)
157. [ ] 
158. [ ] Backend service that orchestrates operations.
159. [ ] 
160. [ ] **Responsibilities:**
161. [ ] - Wrap Coolify API for mobile-friendly operations
162. [ ] - Handle project lifecycle (create, clone, sync)
163. [ ] - Manage background operations
164. [ ] - Coordinate with Forgejo for repo management
165. [ ] - Store and inject LLM credentials into containers
166. [ ] 
167. [ ] **Why Separate Service?**
168. [ ] - Runs independently of mobile app
169. [ ] - Can trigger operations from CI/CD, web, etc.
170. [ ] - Handles long-running background tasks
171. [ ] - Centralizes business logic
172. [ ] 
173. [ ] ### 4. OpenCode Containers
174. [ ] 
175. [ ] Individual Docker containers running OpenCode server mode.
176. [ ] 
177. [ ] **Per-Container Setup:**
178. [ ] - Cloned project from Forgejo
179. [ ] - OpenCode server on unique port
180. [ ] - LLM credentials via environment variables
181. [ ] - Persistent workspace volume
182. [ ] 
183. [ ] **Configuration:**
184. [ ] - Global default LLM provider
185. [ ] - Per-project provider override capability
186. [ ] - Credentials stored in Coolify env vars
187. [ ] 
188. [ ] ### 5. Mobile App (Tauri + Svelte)
189. [ ] 
190. [ ] The "Portable Command Center" itself.
191. [ ] 
192. [ ] **Rust Backend Responsibilities:**
193. [ ] - OAuth proxy for LLM providers (GitHub Copilot, Claude Pro/Max)
194. [ ] - Tailscale connectivity
195. [ ] - Secure credential storage (Keychain/Keystore)
196. [ ] - Native push notification handling
197. [ ] 
198. [ ] **Svelte Frontend:**
199. [ ] - Project list and management
200. [ ] - Chat interface for OpenCode sessions
201. [ ] - File browser with syntax-highlighted viewer
202. [ ] - Server/container status
203. [ ] - LLM provider configuration
204. [ ] - OAuth flow UI
205. [ ] 
206. [ ] ---
207. [ ] 
208. [ ] ## Technology Stack
209. [ ] 
210. [ ] | Layer | Technology | Rationale |
211. [ ] |-------|------------|-----------|
212. [ ] | **Mobile Framework** | Tauri v2 + Svelte | Rust backend for OAuth, small binary, web frontend |
213. [ ] | **Container Orchestration** | Coolify | Already in use, full API |
214. [ ] | **Git Forge** | Forgejo | Self-hosted, lightweight, API, GitHub sync |
215. [ ] | **Network** | Tailscale | Zero-trust VPN, no port forwarding |
216. [ ] | **AI Agent** | OpenCode | Server mode, SDK, 75+ LLM providers |
217. [ ] | **Credentials** | Coolify Env Vars | Simple, per-container, API accessible |
218. [ ] 
219. [ ] ---
220. [ ] 
221. [ ] ## Implementation Phases
222. [ ] 
223. [ ] ### Phase 1: Infrastructure Setup
224. [ ] - [ ] Install Forgejo on Hetzner VPS via Coolify
225. [ ] - [ ] Create OpenCode Docker image
226. [ ] - [ ] Test manual deployment of OpenCode container
227. [ ] 
228. [ ] ### Phase 2: Management API
229. [ ] - [ ] Design API schema (projects, containers, credentials)
230. [ ] - [ ] Implement Coolify API wrapper
231. [ ] - [ ] Implement Forgejo API integration
232. [ ] - [ ] Add project lifecycle endpoints (create, clone, sync)
233. [ ] - [ ] Deploy Management API via Coolify
234. [ ] 
235. [ ] ### Phase 3: Mobile App - Foundation
236. [ ] - [ ] Configure Tauri v2 for iOS/Android builds
237. [ ] - [ ] Implement Rust backend OAuth proxy
238. [ ] - [ ] Build connection layer (Tailscale + API clients)
239. [ ] - [ ] Implement secure credential storage
240. [ ] 
241. [ ] ### Phase 4: Mobile App - Core Features
242. [ ] - [ ] Project list view
243. [ ] - [ ] Create new project flow (empty or from GitHub)
244. [ ] - [ ] OpenCode chat interface
245. [ ] - [ ] Real-time updates via SSE
246. [ ] - [ ] Container status dashboard
247. [ ] 
248. [ ] ### Phase 5: Mobile App - Advanced
249. [ ] - [ ] LLM provider configuration UI
250. [ ] - [ ] OAuth flows (GitHub Copilot, Claude Pro/Max)
251. [ ] - [ ] GitHub sync functionality
252. [ ] - [ ] Push notifications
253. [ ] - [ ] Offline mode / session caching
254. [ ] 
255. [ ] ### Phase 6: Polish & Optimization
256. [ ] - [ ] UI animations and transitions
257. [ ] - [ ] Performance optimization
258. [ ] - [ ] Error handling and recovery
259. [ ] - [ ] Documentation and onboarding
260. [ ] 
261. [ ] ---
262. [ ] 
263. [ ] ## Resources
264. [ ] 
265. [ ] ### OpenCode
266. [ ] - [Documentation](https://opencode.ai/docs)
267. [ ] - [GitHub](https://github.com/sst/opencode)
268. [ ] - [SDK](https://opencode.ai/docs/sdk/)
269. [ ] - [Server API](https://opencode.ai/docs/server/)
270. [ ] - [Providers](https://opencode.ai/docs/providers/)
271. [ ] 
272. [ ] ### Coolify
273. [ ] - [Documentation](https://coolify.io/docs)
274. [ ] - [API Reference](https://coolify.io/docs/api-reference/authorization)
275. [ ] 
276. [ ] ### Forgejo
277. [ ] - [Website](https://forgejo.org/)
278. [ ] - [Documentation](https://forgejo.org/docs/)
279. [ ] 
280. [ ] ### Tauri
281. [ ] - [Tauri v2](https://v2.tauri.app/)
282. [ ] - [Mobile Support](https://v2.tauri.app/start/)
283. [ ] 
284. [ ] ### Tailscale
285. [ ] - [Documentation](https://tailscale.com/kb)
286. [ ] 
287. [ ] ---
288. [ ] 
289. [ ] ## Related Documents
290. [ ] 
291. [ ] - [User Journey](./user-journey.md) — Detailed user flows and interactions
292. [ ] - [Technical Architecture](./technical-architecture.md) — Deep dive into system design
293. [ ] 
294. [ ] ---
295. [ ] 
296. [ ] *Document created: December 2024*
297. [ ] *Last updated: December 2024*
298. [ ] 