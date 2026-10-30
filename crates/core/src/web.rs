//! Shared HTTP plumbing for the API: the error shape the screens expect.
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

/// A request input problem, answered with 400 instead of 500.
#[derive(Debug)]
pub struct Invalid(pub String);

impl std::fmt::Display for Invalid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Invalid {}

pub fn invalid(message: impl Into<String>) -> anyhow::Error {
    Invalid(message.into()).into()
}

pub struct AppError(pub anyhow::Error);

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(e: E) -> Self {
        AppError(e.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let e = self.0;
        eprintln!("{e}");
        let status = if e.downcast_ref::<Invalid>().is_some() || e.downcast_ref::<serde_json::Error>().is_some() {
            StatusCode::BAD_REQUEST
        } else if e.chain().any(|c| c.downcast_ref::<std::io::Error>().is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound)) {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };
        (status, Json(json!({ "error": e.to_string() }))).into_response()
    }
}

pub type ApiResult<T = Json<serde_json::Value>> = Result<T, AppError>;

pub fn ok() -> ApiResult {
    Ok(Json(json!({ "ok": true })))
}
