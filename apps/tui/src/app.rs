use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::Frame;

use crate::api::{sandboxes::CreateSandboxRequest, ApiClient};
use crate::cli::Cli;
use crate::config::Config;
use crate::event::ApiResult;
use crate::types::{Sandbox, SandboxStats, SandboxStatus};
use crate::ui;

const CREATE_SANDBOX_FLAVORS: [&str; 7] = [
    "js",
    "python",
    "go",
    "rust",
    "fullstack",
    "polyglot",
    "bare",
];
const CREATE_SANDBOX_RESOURCE_TIERS: [&str; 2] = ["starter", "builder"];
const CREATE_SANDBOX_ADDONS: [&str; 1] = ["code-server"];

/// Available views
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum View {
    Login,
    Dashboard,
    SandboxDetail,
    CreateSandbox,
    Chat,
    Terminal,
    Files,
    Git,
    Providers,
    Settings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxDetailTab {
    Overview,
    Stats,
    Logs,
}

pub struct SandboxDetailState {
    pub sandbox_id: Option<String>,
    pub tab: SandboxDetailTab,
    pub sandbox: Option<Sandbox>,
    pub stats: Option<SandboxStats>,
    pub logs: Option<String>,
    pub error: Option<String>,
    pub loading_detail: bool,
    pub loading_stats: bool,
    pub loading_logs: bool,
}

impl SandboxDetailState {
    fn new() -> Self {
        Self {
            sandbox_id: None,
            tab: SandboxDetailTab::Overview,
            sandbox: None,
            stats: None,
            logs: None,
            error: None,
            loading_detail: false,
            loading_stats: false,
            loading_logs: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreateSandboxStep {
    Source,
    Details,
    Runtime,
    Addons,
    Review,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreateSandboxSource {
    Scratch,
    Git,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateSandboxWizardState {
    pub step: CreateSandboxStep,
    pub source: CreateSandboxSource,
    pub focus: usize,
    pub name: String,
    pub description: String,
    pub git_url: String,
    pub selected_flavor: String,
    pub selected_resource_tier: String,
    pub selected_addons: Vec<String>,
    pub error: Option<String>,
    pub submitting: bool,
}

impl CreateSandboxWizardState {
    fn new(config: &Config) -> Self {
        Self {
            step: CreateSandboxStep::Source,
            source: CreateSandboxSource::Scratch,
            focus: 0,
            name: String::new(),
            description: String::new(),
            git_url: String::new(),
            selected_flavor: config.defaults.flavor.clone(),
            selected_resource_tier: config.defaults.resource_tier.clone(),
            selected_addons: vec!["code-server".to_string()],
            error: None,
            submitting: false,
        }
    }
}

/// Application state
pub struct App {
    // Configuration
    pub config: Config,
    pub cli: Cli,

    // API
    pub api: ApiClient,
    pub connected: bool,
    pub api_url: String,

    // State
    pub should_quit: bool,
    pub active_view: View,
    pub create_sandbox: CreateSandboxWizardState,
    pub sandbox_detail: SandboxDetailState,

    // Login
    pub login_email: String,
    pub login_password: String,
    pub login_focus: usize, // 0 = email, 1 = password
    pub login_error: Option<String>,

    // Dashboard
    pub sandboxes: Vec<Sandbox>,
    pub selected_sandbox: usize,
    pub sandboxes_loaded: bool,
}

impl App {
    pub fn new(config: Config, cli: Cli) -> Self {
        let api_url = config.effective_api_url(cli.api_url.as_deref());
        let token = config.effective_token(cli.token.as_deref());
        let has_token = token.is_some();

        let api = ApiClient::new(&api_url, token);
        let create_sandbox = CreateSandboxWizardState::new(&config);

        // Start on login if no token, otherwise dashboard
        let active_view = if has_token {
            View::Dashboard
        } else {
            View::Login
        };

        Self {
            config,
            cli,
            api,
            connected: false,
            api_url,
            should_quit: false,
            active_view,
            create_sandbox,
            sandbox_detail: SandboxDetailState::new(),
            login_email: String::new(),
            login_password: String::new(),
            login_focus: 0,
            login_error: None,
            sandboxes: Vec::new(),
            selected_sandbox: 0,
            sandboxes_loaded: false,
        }
    }

    /// Render the application
    pub fn render(&self, frame: &mut Frame) {
        ui::render(frame, self);
    }

    /// Handle tick events (periodic updates)
    pub async fn tick(&mut self) {
        // Check connection on first tick if we have a token
        if !self.connected && self.api.has_token() {
            match self.api.test_connection().await {
                Ok(true) => {
                    self.connected = true;
                    // Load sandboxes on first connection
                    if !self.sandboxes_loaded {
                        self.load_sandboxes().await;
                    }
                }
                _ => {}
            }
        }
    }

    /// Handle keyboard input
    pub async fn handle_key_event(&mut self, key: KeyEvent) {
        // Global key handling
        match key.code {
            KeyCode::Char('q')
                if self.active_view != View::Login
                    && self.active_view != View::CreateSandbox
                    && self.active_view != View::SandboxDetail =>
            {
                self.should_quit = true;
                return;
            }
            KeyCode::Char('?') => {
                // TODO: Show help
                return;
            }
            _ => {}
        }

        // View-specific key handling
        match self.active_view {
            View::Login => self.handle_login_keys(key).await,
            View::Dashboard => self.handle_dashboard_keys(key).await,
            View::SandboxDetail => self.handle_sandbox_detail_keys(key).await,
            View::CreateSandbox => self.handle_create_sandbox_keys(key).await,
            View::Chat => self.handle_chat_keys(key).await,
            View::Terminal => self.handle_terminal_keys(key).await,
            View::Files => self.handle_files_keys(key).await,
            View::Git => self.handle_git_keys(key).await,
            View::Providers => self.handle_providers_keys(key).await,
            View::Settings => self.handle_settings_keys(key).await,
        }
    }

    /// Handle login view keys
    async fn handle_login_keys(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Tab => {
                self.login_focus = (self.login_focus + 1) % 2;
            }
            KeyCode::BackTab => {
                self.login_focus = (self.login_focus + 1) % 2;
            }
            KeyCode::Enter => {
                self.attempt_login().await;
            }
            KeyCode::Esc => {
                // If we have a token, go to dashboard
                if self.api.has_token() {
                    self.active_view = View::Dashboard;
                }
            }
            KeyCode::Char(c) => {
                if self.login_focus == 0 {
                    self.login_email.push(c);
                } else {
                    self.login_password.push(c);
                }
            }
            KeyCode::Backspace => {
                if self.login_focus == 0 {
                    self.login_email.pop();
                } else {
                    self.login_password.pop();
                }
            }
            _ => {}
        }
    }

    /// Handle dashboard view keys
    async fn handle_dashboard_keys(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Char('n') => {
                self.open_create_sandbox();
            }
            KeyCode::Char('s') => {
                self.start_selected_sandbox().await;
            }
            KeyCode::Char('x') => {
                self.stop_selected_sandbox().await;
            }
            KeyCode::Char('R') => {
                self.restart_selected_sandbox().await;
            }
            KeyCode::Char('p') => {
                self.pause_selected_sandbox().await;
            }
            KeyCode::Char('u') => {
                self.unpause_selected_sandbox().await;
            }
            KeyCode::Char('d') => {
                self.delete_selected_sandbox().await;
            }
            KeyCode::Char('r') => {
                self.load_sandboxes().await;
            }
            KeyCode::Up | KeyCode::Char('k') => {
                if !self.sandboxes.is_empty() {
                    self.selected_sandbox = self.selected_sandbox.saturating_sub(1);
                }
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if !self.sandboxes.is_empty() {
                    self.selected_sandbox =
                        (self.selected_sandbox + 1).min(self.sandboxes.len() - 1);
                }
            }
            KeyCode::Enter => {
                self.open_selected_sandbox_detail().await;
            }
            KeyCode::Tab => {
                self.active_view = View::Chat;
            }
            KeyCode::BackTab => {
                self.active_view = View::Settings;
            }
            _ => {}
        }
    }

    async fn handle_sandbox_detail_keys(&mut self, key: KeyEvent) {
        if key.code == KeyCode::Esc {
            self.active_view = View::Dashboard;
        }
    }

    /// Handle chat view keys
    async fn handle_chat_keys(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Tab => {
                self.active_view = View::Terminal;
            }
            KeyCode::BackTab => {
                self.active_view = View::Dashboard;
            }
            _ => {}
        }
    }

    /// Handle terminal view keys
    async fn handle_terminal_keys(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Tab => {
                self.active_view = View::Files;
            }
            KeyCode::BackTab => {
                self.active_view = View::Chat;
            }
            _ => {}
        }
    }

    /// Handle files view keys
    async fn handle_files_keys(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Tab => {
                self.active_view = View::Git;
            }
            KeyCode::BackTab => {
                self.active_view = View::Terminal;
            }
            _ => {}
        }
    }

    /// Handle git view keys
    async fn handle_git_keys(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Tab => {
                self.active_view = View::Providers;
            }
            KeyCode::BackTab => {
                self.active_view = View::Files;
            }
            _ => {}
        }
    }

    /// Handle providers view keys
    async fn handle_providers_keys(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Tab => {
                self.active_view = View::Settings;
            }
            KeyCode::BackTab => {
                self.active_view = View::Git;
            }
            _ => {}
        }
    }

    /// Handle settings view keys
    async fn handle_settings_keys(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Tab => {
                self.active_view = View::Dashboard;
            }
            KeyCode::BackTab => {
                self.active_view = View::Providers;
            }
            _ => {}
        }
    }

    /// Handle API results
    pub fn handle_api_result(&mut self, result: ApiResult) {
        match result {
            ApiResult::LoginSuccess { token } => {
                self.api.set_token(Some(token));
                self.connected = true;
                self.active_view = View::Dashboard;
                self.login_error = None;
                self.login_password = String::new(); // Clear password
            }
            ApiResult::LoginError { message } => {
                self.login_error = Some(message);
                self.login_password = String::new(); // Clear password on error
            }
            ApiResult::SandboxesLoaded { sandboxes } => {
                // Parse sandboxes from JSON
                self.sandboxes = sandboxes
                    .into_iter()
                    .filter_map(|s| serde_json::from_value(s).ok())
                    .collect();
                self.sandboxes_loaded = true;
            }
            ApiResult::Success { message: _ } => {}
            ApiResult::Error { message: _ } => {}
        }
    }

    /// Handle connection status change
    pub fn handle_connection_status(&mut self, connected: bool) {
        self.connected = connected;
    }

    fn open_create_sandbox(&mut self) {
        self.create_sandbox = CreateSandboxWizardState::new(&self.config);
        self.active_view = View::CreateSandbox;
    }

    fn cancel_create_sandbox(&mut self) {
        self.create_sandbox = CreateSandboxWizardState::new(&self.config);
        self.active_view = View::Dashboard;
    }

    async fn open_selected_sandbox_detail(&mut self) {
        let Some(snapshot) = self.sandboxes.get(self.selected_sandbox).cloned() else {
            return;
        };
        let sandbox_id = snapshot.id.clone();

        self.sandbox_detail = SandboxDetailState {
            sandbox_id: Some(sandbox_id.clone()),
            tab: SandboxDetailTab::Overview,
            sandbox: Some(snapshot),
            stats: None,
            logs: None,
            error: None,
            loading_detail: true,
            loading_stats: false,
            loading_logs: false,
        };
        self.active_view = View::SandboxDetail;

        match self.api.get_sandbox(&sandbox_id).await {
            Ok(sandbox) => {
                self.sandbox_detail.sandbox = Some(sandbox);
                self.sandbox_detail.error = None;
            }
            Err(error) => {
                self.sandbox_detail.error = Some(error.to_string());
            }
        }
        self.sandbox_detail.loading_detail = false;
    }

    fn create_sandbox_next_step(&mut self) {
        self.create_sandbox.error = None;

        match self.create_sandbox.step {
            CreateSandboxStep::Source => {
                if self.create_sandbox.source == CreateSandboxSource::Git {
                    if !self.create_sandbox_git_url_valid() {
                        self.create_sandbox.error =
                            Some("Git URL must be a GitHub or GitLab repository URL".to_string());
                        return;
                    }

                    if self.create_sandbox.name.trim().is_empty() {
                        if let Some(repo_name) = self.create_sandbox_git_repo_name() {
                            self.create_sandbox.name = repo_name;
                        }
                    }
                }
                self.create_sandbox.step = CreateSandboxStep::Details;
                self.create_sandbox.focus = 0;
            }
            CreateSandboxStep::Details => {
                if self.create_sandbox.name.trim().is_empty() {
                    self.create_sandbox.error = Some("name is required".to_string());
                    return;
                }
                self.create_sandbox.step = CreateSandboxStep::Runtime;
                self.create_sandbox.focus = 0;
            }
            CreateSandboxStep::Runtime => {
                self.create_sandbox.step = CreateSandboxStep::Addons;
                self.create_sandbox.focus = 0;
            }
            CreateSandboxStep::Addons => {
                self.create_sandbox.step = CreateSandboxStep::Review;
                self.create_sandbox.focus = 0;
            }
            CreateSandboxStep::Review => {}
        }
    }

    fn create_sandbox_previous_step(&mut self) {
        self.create_sandbox.error = None;

        self.create_sandbox.step = match self.create_sandbox.step {
            CreateSandboxStep::Source => {
                self.cancel_create_sandbox();
                return;
            }
            CreateSandboxStep::Details => CreateSandboxStep::Source,
            CreateSandboxStep::Runtime => CreateSandboxStep::Details,
            CreateSandboxStep::Addons => CreateSandboxStep::Runtime,
            CreateSandboxStep::Review => CreateSandboxStep::Addons,
        };
        self.create_sandbox.focus = 0;
    }

    fn create_sandbox_git_url_valid(&self) -> bool {
        self.create_sandbox_git_repo_name().is_some()
    }

    fn create_sandbox_git_repo_name(&self) -> Option<String> {
        let url = self.create_sandbox.git_url.trim();
        if url.contains(['?', '#']) {
            return None;
        }

        let path = url
            .strip_prefix("https://github.com/")
            .or_else(|| url.strip_prefix("http://github.com/"))
            .or_else(|| url.strip_prefix("https://gitlab.com/"))
            .or_else(|| url.strip_prefix("http://gitlab.com/"))?;
        let mut segments = path.split('/').filter(|segment| !segment.is_empty());
        segments.next()?;
        let repo = segments.next()?.trim_end_matches(".git");
        if repo.is_empty() || segments.next().is_some() {
            None
        } else {
            Some(repo.to_string())
        }
    }

    fn create_sandbox_request_name(&self) -> String {
        let entered = self.create_sandbox.name.trim();
        if !entered.is_empty() {
            return entered.to_string();
        }

        if self.create_sandbox.source == CreateSandboxSource::Git {
            if let Some(name) = self.create_sandbox_git_repo_name() {
                return name;
            }
        }

        "imported-project".to_string()
    }

    fn build_create_sandbox_request(&self) -> CreateSandboxRequest {
        CreateSandboxRequest {
            name: self.create_sandbox_request_name(),
            description: if self.create_sandbox.description.trim().is_empty() {
                None
            } else {
                Some(self.create_sandbox.description.trim().to_string())
            },
            github_url: if self.create_sandbox.source == CreateSandboxSource::Git {
                Some(self.create_sandbox.git_url.trim().to_string())
            } else {
                None
            },
            flavor: Some(self.create_sandbox.selected_flavor.clone()),
            resource_tier: Some(self.create_sandbox.selected_resource_tier.clone()),
            addons: if self.create_sandbox.selected_addons.is_empty() {
                None
            } else {
                Some(self.create_sandbox.selected_addons.clone())
            },
        }
    }

    async fn submit_create_sandbox(&mut self) {
        if self.create_sandbox.step != CreateSandboxStep::Review || self.create_sandbox.submitting {
            return;
        }

        self.create_sandbox.error = None;
        self.create_sandbox.submitting = true;
        let request = self.build_create_sandbox_request();

        match self.api.create_sandbox(request).await {
            Ok(sandbox) => {
                self.sandboxes.push(sandbox);
                self.selected_sandbox = self.sandboxes.len().saturating_sub(1);
                self.sandboxes_loaded = true;
                self.create_sandbox = CreateSandboxWizardState::new(&self.config);
                self.active_view = View::Dashboard;
            }
            Err(error) => {
                self.create_sandbox.submitting = false;
                self.create_sandbox.error = Some(error.to_string());
            }
        }
    }

    fn create_sandbox_focus_count(&self) -> usize {
        match self.create_sandbox.step {
            CreateSandboxStep::Source => {
                if self.create_sandbox.source == CreateSandboxSource::Git {
                    2
                } else {
                    1
                }
            }
            CreateSandboxStep::Details => 2,
            CreateSandboxStep::Runtime => 2,
            CreateSandboxStep::Addons => CREATE_SANDBOX_ADDONS.len().max(1),
            CreateSandboxStep::Review => 1,
        }
    }

    fn create_sandbox_move_focus_forward(&mut self) {
        let count = self.create_sandbox_focus_count();
        self.create_sandbox.focus = (self.create_sandbox.focus + 1) % count;
    }

    fn create_sandbox_move_focus_backward(&mut self) {
        let count = self.create_sandbox_focus_count();
        self.create_sandbox.focus = if self.create_sandbox.focus == 0 {
            count - 1
        } else {
            self.create_sandbox.focus - 1
        };
    }

    fn create_sandbox_type_char(&mut self, c: char) {
        match self.create_sandbox.step {
            CreateSandboxStep::Source
                if self.create_sandbox.source == CreateSandboxSource::Git
                    && self.create_sandbox.focus == 1 =>
            {
                self.create_sandbox.git_url.push(c);
            }
            CreateSandboxStep::Details if self.create_sandbox.focus == 0 => {
                self.create_sandbox.name.push(c);
            }
            CreateSandboxStep::Details if self.create_sandbox.focus == 1 => {
                self.create_sandbox.description.push(c);
            }
            _ => {}
        }
    }

    fn create_sandbox_backspace(&mut self) {
        match self.create_sandbox.step {
            CreateSandboxStep::Source
                if self.create_sandbox.source == CreateSandboxSource::Git
                    && self.create_sandbox.focus == 1 =>
            {
                self.create_sandbox.git_url.pop();
            }
            CreateSandboxStep::Details if self.create_sandbox.focus == 0 => {
                self.create_sandbox.name.pop();
            }
            CreateSandboxStep::Details if self.create_sandbox.focus == 1 => {
                self.create_sandbox.description.pop();
            }
            _ => {}
        }
    }

    fn create_sandbox_move_selection(&mut self, delta: isize) {
        match self.create_sandbox.step {
            CreateSandboxStep::Runtime if self.create_sandbox.focus == 0 => {
                let current = CREATE_SANDBOX_FLAVORS
                    .iter()
                    .position(|flavor| *flavor == self.create_sandbox.selected_flavor)
                    .unwrap_or(0);
                let next = (current as isize + delta)
                    .clamp(0, (CREATE_SANDBOX_FLAVORS.len() - 1) as isize)
                    as usize;
                self.create_sandbox.selected_flavor = CREATE_SANDBOX_FLAVORS[next].to_string();
            }
            CreateSandboxStep::Runtime if self.create_sandbox.focus == 1 => {
                let current = CREATE_SANDBOX_RESOURCE_TIERS
                    .iter()
                    .position(|tier| *tier == self.create_sandbox.selected_resource_tier)
                    .unwrap_or(0);
                let next = (current as isize + delta)
                    .clamp(0, (CREATE_SANDBOX_RESOURCE_TIERS.len() - 1) as isize)
                    as usize;
                self.create_sandbox.selected_resource_tier =
                    CREATE_SANDBOX_RESOURCE_TIERS[next].to_string();
            }
            _ => {}
        }
    }

    fn create_sandbox_toggle_current(&mut self) {
        match self.create_sandbox.step {
            CreateSandboxStep::Source => {
                self.create_sandbox.source = match self.create_sandbox.source {
                    CreateSandboxSource::Scratch => CreateSandboxSource::Git,
                    CreateSandboxSource::Git => CreateSandboxSource::Scratch,
                };
                self.create_sandbox.error = None;
                self.create_sandbox.focus =
                    if self.create_sandbox.source == CreateSandboxSource::Git {
                        1
                    } else {
                        0
                    };
            }
            CreateSandboxStep::Addons => {
                let addon = CREATE_SANDBOX_ADDONS[self
                    .create_sandbox
                    .focus
                    .min(CREATE_SANDBOX_ADDONS.len() - 1)];
                if self
                    .create_sandbox
                    .selected_addons
                    .iter()
                    .any(|selected| selected == addon)
                {
                    self.create_sandbox
                        .selected_addons
                        .retain(|selected| selected != addon);
                } else {
                    self.create_sandbox.selected_addons.push(addon.to_string());
                }
            }
            _ => {}
        }
    }

    async fn handle_create_sandbox_keys(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc => self.create_sandbox_previous_step(),
            KeyCode::Enter => self.create_sandbox_next_step(),
            KeyCode::Tab => self.create_sandbox_move_focus_forward(),
            KeyCode::BackTab => self.create_sandbox_move_focus_backward(),
            KeyCode::Up | KeyCode::Char('k')
                if self.create_sandbox.step == CreateSandboxStep::Runtime =>
            {
                self.create_sandbox_move_selection(-1)
            }
            KeyCode::Down | KeyCode::Char('j')
                if self.create_sandbox.step == CreateSandboxStep::Runtime =>
            {
                self.create_sandbox_move_selection(1)
            }
            KeyCode::Backspace => self.create_sandbox_backspace(),
            KeyCode::Char(' ')
                if matches!(
                    self.create_sandbox.step,
                    CreateSandboxStep::Source | CreateSandboxStep::Addons
                ) =>
            {
                self.create_sandbox_toggle_current();
            }
            KeyCode::Char('s') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.submit_create_sandbox().await;
            }
            KeyCode::Char(c)
                if key.modifiers.is_empty() || key.modifiers == KeyModifiers::SHIFT =>
            {
                self.create_sandbox_type_char(c);
            }
            _ => {}
        }
    }

    /// Attempt login
    async fn attempt_login(&mut self) {
        // Validate email
        if self.login_email.trim().is_empty() {
            self.login_error = Some("email is required".to_string());
            return;
        }

        // Validate password
        if self.login_password.is_empty() {
            self.login_error = Some("password is required".to_string());
            return;
        }

        // Clear previous errors
        self.login_error = None;

        match self
            .api
            .login(&self.login_email, &self.login_password)
            .await
        {
            Ok(response) => {
                let token = response.token;
                self.config.connection.api_token = Some(token.clone());
                self.api.set_token(Some(token));
                self.connected = true;
                self.active_view = View::Dashboard;
                self.login_password = String::new();

                let config_path = match &self.cli.config {
                    Some(path) => Ok(path.clone()),
                    None => Config::default_path(),
                };

                if let Ok(path) = config_path {
                    if let Err(error) = self.config.save(&path) {
                        self.login_error = Some(format!("Failed to save token: {error}"));
                    }
                }
            }
            Err(error) => {
                self.login_error = Some(error.to_string());
                self.login_password = String::new();
            }
        }
    }

    /// Load sandboxes from API
    async fn load_sandboxes(&mut self) {
        if let Ok(sandboxes) = self.api.list_sandboxes().await {
            self.sandboxes = sandboxes;
            if !self.sandboxes.is_empty() {
                self.selected_sandbox = self.selected_sandbox.min(self.sandboxes.len() - 1);
            } else {
                self.selected_sandbox = 0;
            }
            self.sandboxes_loaded = true;
        }
    }

    async fn start_selected_sandbox(&mut self) {
        let Some(sandbox) = self.sandboxes.get(self.selected_sandbox) else {
            return;
        };
        let sandbox_id = sandbox.id.clone();

        if self.api.start_sandbox(&sandbox_id).await.is_ok() {
            if let Some(sandbox) = self.sandboxes.get_mut(self.selected_sandbox) {
                sandbox.status = SandboxStatus::Running;
            }
        }
    }

    async fn stop_selected_sandbox(&mut self) {
        let Some(sandbox) = self.sandboxes.get(self.selected_sandbox) else {
            return;
        };
        let sandbox_id = sandbox.id.clone();

        if self.api.stop_sandbox(&sandbox_id).await.is_ok() {
            if let Some(sandbox) = self.sandboxes.get_mut(self.selected_sandbox) {
                sandbox.status = SandboxStatus::Stopped;
            }
        }
    }

    async fn restart_selected_sandbox(&mut self) {
        let Some(sandbox) = self.sandboxes.get(self.selected_sandbox) else {
            return;
        };
        let sandbox_id = sandbox.id.clone();

        if self.api.restart_sandbox(&sandbox_id).await.is_ok() {
            if let Some(sandbox) = self.sandboxes.get_mut(self.selected_sandbox) {
                sandbox.status = SandboxStatus::Running;
            }
        }
    }

    async fn pause_selected_sandbox(&mut self) {
        let Some(sandbox) = self.sandboxes.get(self.selected_sandbox) else {
            return;
        };
        let sandbox_id = sandbox.id.clone();

        if self.api.pause_sandbox(&sandbox_id).await.is_ok() {
            if let Some(sandbox) = self.sandboxes.get_mut(self.selected_sandbox) {
                sandbox.status = SandboxStatus::Paused;
            }
        }
    }

    async fn unpause_selected_sandbox(&mut self) {
        let Some(sandbox) = self.sandboxes.get(self.selected_sandbox) else {
            return;
        };
        let sandbox_id = sandbox.id.clone();

        if self.api.unpause_sandbox(&sandbox_id).await.is_ok() {
            if let Some(sandbox) = self.sandboxes.get_mut(self.selected_sandbox) {
                sandbox.status = SandboxStatus::Running;
            }
        }
    }

    async fn delete_selected_sandbox(&mut self) {
        let Some(sandbox) = self.sandboxes.get(self.selected_sandbox) else {
            return;
        };
        let sandbox_id = sandbox.id.clone();

        if self.api.delete_sandbox(&sandbox_id).await.is_ok() {
            self.sandboxes.remove(self.selected_sandbox);
            if self.sandboxes.is_empty() {
                self.selected_sandbox = 0;
            } else {
                self.selected_sandbox = self.selected_sandbox.min(self.sandboxes.len() - 1);
            }
        }
    }
}
