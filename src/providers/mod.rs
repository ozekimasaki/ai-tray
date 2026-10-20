mod claude;
mod codex;
mod cursor;
mod parse;

pub use parse::{percent_from_window, reset_ms_from_window};

use crate::model::{now_ms, ProviderCard, ProviderId, Status};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    Auth,
    Network,
    NotFound,
    Unknown,
}

pub fn fetch_one(id: ProviderId, now: i64) -> ProviderCard {
    match id {
        ProviderId::Claude => claude::fetch(now),
        ProviderId::Codex => codex::fetch(now),
        ProviderId::Cursor => cursor::fetch(now),
    }
}

pub fn fetch_enabled(state: &crate::model::AppState) -> Vec<ProviderCard> {
    let now = now_ms();
    if state.demo {
        return crate::model::demo_cards(now)
            .into_iter()
            .filter(|p| state.enabled(p.id))
            .collect();
    }
    ProviderId::all()
        .into_iter()
        .filter(|id| state.enabled(*id))
        .map(|id| fetch_one(id, now))
        .collect()
}

pub fn fail(id: ProviderId, kind: ErrorKind, text: impl Into<String>) -> ProviderCard {
    let mut card = ProviderCard::idle(id, true);
    card.status = match kind {
        ErrorKind::NotFound => Status::Missing,
        _ => Status::Failed,
    };
    card.error = text.into();
    card.source = "auto".into();
    card
}

pub fn ok(
    id: ProviderId,
    account: impl Into<String>,
    plan: impl Into<String>,
    bars: Vec<crate::model::Bar>,
) -> ProviderCard {
    let mut card = ProviderCard::idle(id, true);
    card.status = Status::Ready;
    card.account = account.into();
    card.plan = plan.into();
    card.bars = bars;
    card.source = "auto".into();
    card
}
