use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::widgets::{Block, Borders, Paragraph, Tabs, Wrap};

use crate::app::{App, SandboxDetailTab};
use crate::util::format_bytes;

pub fn render(frame: &mut Frame, app: &App, area: Rect) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(0),
            Constraint::Length(2),
        ])
        .split(area);

    render_detail_tabs(frame, app, chunks[0]);
    render_active_tab(frame, app, chunks[1]);
    render_help(frame, chunks[2]);
}

fn render_detail_tabs(frame: &mut Frame, app: &App, area: Rect) {
    let selected = match app.sandbox_detail.tab {
        SandboxDetailTab::Overview => 0,
        SandboxDetailTab::Stats => 1,
        SandboxDetailTab::Logs => 2,
    };

    let title = app
        .sandbox_detail
        .sandbox
        .as_ref()
        .map(|sandbox| format!(" Sandbox: {} [{}] ", sandbox.name, sandbox.status))
        .unwrap_or_else(|| " Sandbox Detail ".to_string());

    let tabs = Tabs::new(vec!["Overview", "Stats", "Logs"])
        .block(Block::default().title(title).borders(Borders::ALL))
        .select(selected)
        .style(Style::default().fg(Color::White))
        .highlight_style(
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        );

    frame.render_widget(tabs, area);
}

fn render_active_tab(frame: &mut Frame, app: &App, area: Rect) {
    let mut lines = match app.sandbox_detail.tab {
        SandboxDetailTab::Overview => overview_lines(app),
        SandboxDetailTab::Stats => stats_lines(app),
        SandboxDetailTab::Logs => logs_lines(app),
    };

    if let Some(error) = &app.sandbox_detail.error {
        lines.push(String::new());
        lines.push(format!("Error: {error}"));
    }

    let title = match app.sandbox_detail.tab {
        SandboxDetailTab::Overview => "Overview",
        SandboxDetailTab::Stats => "Stats",
        SandboxDetailTab::Logs => "Logs",
    };

    let content = Paragraph::new(lines.join("\n"))
        .block(Block::default().title(title).borders(Borders::ALL))
        .wrap(Wrap { trim: false });

    frame.render_widget(content, area);
}

fn overview_lines(app: &App) -> Vec<String> {
    let Some(sandbox) = &app.sandbox_detail.sandbox else {
        return vec!["No sandbox selected".to_string()];
    };

    vec![
        format!("Name: {}", sandbox.name),
        format!("Status: {}", sandbox.status),
        format!("ID: {}", sandbox.id),
        format!(
            "Description: {}",
            sandbox.description.as_deref().unwrap_or("-")
        ),
        format!("Git URL: {}", sandbox.git_url.as_deref().unwrap_or("-")),
        format!("Flavor: {}", sandbox.flavor_id.as_deref().unwrap_or("-")),
        format!(
            "Resource tier: {}",
            sandbox.resource_tier_id.as_deref().unwrap_or("-")
        ),
        format!(
            "Container: {}",
            sandbox.container_id.as_deref().unwrap_or("-")
        ),
        format!("Created: {}", sandbox.created_at),
        format!("Updated: {}", sandbox.updated_at),
    ]
}

fn stats_lines(app: &App) -> Vec<String> {
    let Some(stats) = &app.sandbox_detail.stats else {
        return vec!["No stats loaded. Press r to refresh.".to_string()];
    };

    vec![
        format!("CPU: {:.1}%", stats.cpu_percent),
        format!(
            "Memory: {} / {} ({:.1}%)",
            format_bytes(stats.memory_usage),
            format_bytes(stats.memory_limit),
            stats.memory_percent
        ),
        format!(
            "Network RX/TX: {} / {}",
            format_bytes(stats.network_rx),
            format_bytes(stats.network_tx)
        ),
        format!(
            "Block read/write: {} / {}",
            format_bytes(stats.block_read),
            format_bytes(stats.block_write)
        ),
    ]
}

fn logs_lines(app: &App) -> Vec<String> {
    match &app.sandbox_detail.logs {
        Some(logs) if !logs.is_empty() => logs.lines().map(str::to_string).collect(),
        Some(_) => vec!["No logs available".to_string()],
        None => vec!["No logs loaded. Press r to refresh.".to_string()],
    }
}

fn render_help(frame: &mut Frame, area: Rect) {
    let help = Paragraph::new(
        " Tab: next tab | Shift+Tab: previous tab | 1/2/3: jump | r: refresh | Esc: dashboard ",
    )
    .style(Style::default().fg(Color::DarkGray));

    frame.render_widget(help, area);
}
