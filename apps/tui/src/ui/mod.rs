use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::widgets::{Block, Borders, Paragraph, Tabs};

use crate::app::App;

pub mod theme;
pub mod views;
pub mod widgets;

/// Root renderer for the application
pub fn render(frame: &mut Frame, app: &App) {
    let size = frame.area();

    // Main layout: content + status bar
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // Tab bar
            Constraint::Min(0),   // Content
            Constraint::Length(1), // Status bar
        ])
        .split(size);

    // Render tab bar
    render_tab_bar(frame, app, chunks[0]);

    // Render content based on active view
    match app.active_view {
        crate::app::View::Login => views::login::render(frame, app, chunks[1]),
        crate::app::View::Dashboard => views::dashboard::render(frame, app, chunks[1]),
        crate::app::View::SandboxDetail => views::dashboard::render(frame, app, chunks[1]),
        crate::app::View::CreateSandbox => views::create_sandbox::render(frame, app, chunks[1]),
        crate::app::View::Chat => views::chat::render(frame, app, chunks[1]),
        crate::app::View::Terminal => views::terminal::render(frame, app, chunks[1]),
        crate::app::View::Files => views::files::render(frame, app, chunks[1]),
        crate::app::View::Git => views::git::render(frame, app, chunks[1]),
        crate::app::View::Providers => views::providers::render(frame, app, chunks[1]),
        crate::app::View::Settings => views::settings::render(frame, app, chunks[1]),
    }

    // Render status bar
    render_status_bar(frame, app, chunks[2]);
}

/// Render the tab bar
fn render_tab_bar(frame: &mut Frame, app: &App, area: Rect) {
    let titles = vec![
        "Dashboard",
        "Chat",
        "Terminal",
        "Files",
        "Git",
        "Providers",
        "Settings",
    ];

    let selected = match app.active_view {
        crate::app::View::Login => 0,
        crate::app::View::Dashboard => 0,
        crate::app::View::SandboxDetail => 0,
        crate::app::View::CreateSandbox => 0,
        crate::app::View::Chat => 1,
        crate::app::View::Terminal => 2,
        crate::app::View::Files => 3,
        crate::app::View::Git => 4,
        crate::app::View::Providers => 5,
        crate::app::View::Settings => 6,
    };

    let tabs = Tabs::new(titles)
        .block(
            Block::default()
                .title(" AgentPod ")
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::DarkGray)),
        )
        .select(selected)
        .style(Style::default().fg(Color::White))
        .highlight_style(
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        );

    frame.render_widget(tabs, area);
}

/// Render the status bar
fn render_status_bar(frame: &mut Frame, app: &App, area: Rect) {
    let status = if app.connected {
        format!(
            " Connected: {} | Press ? for help | q to quit",
            app.api_url
        )
    } else {
        format!(" Disconnected: {} | Press ? for help", app.api_url)
    };

    let style = if app.connected {
        Style::default().fg(Color::Green)
    } else {
        Style::default().fg(Color::Red)
    };

    let status_bar = Paragraph::new(status).style(style);
    frame.render_widget(status_bar, area);
}
