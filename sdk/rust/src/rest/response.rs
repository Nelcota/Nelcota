//! Decode cardinality without copying the buffered JSON representation.
use crate::{Error, Response, Result};
use serde::de::DeserializeOwned;
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Cardinality {
    Many,
    One,
    Maybe,
}

pub(super) fn decode<T: DeserializeOwned>(
    response: Response<Value>,
    cardinality: Cardinality,
) -> Result<Response<T>> {
    let data = match cardinality {
        Cardinality::Many => response.data,
        mode => {
            let mut rows =
                match response.data {
                    Value::Array(rows) => rows,
                    _ => return Err(Error::InvalidResponse {
                        status: response.status,
                        message:
                            "single requires an array response; request representation for writes"
                                .into(),
                    }),
                };
            match rows.len() {
                1 => rows.remove(0),
                0 if mode == Cardinality::Maybe => Value::Null,
                actual => {
                    return Err(Error::Cardinality {
                        expected: match mode == Cardinality::One {
                            true => "exactly one",
                            false => "at most one",
                        },
                        actual,
                    });
                }
            }
        }
    };
    let data = serde_json::from_value(data).map_err(|e| Error::InvalidResponse {
        status: response.status,
        message: e.to_string(),
    })?;
    Ok(Response {
        data,
        status: response.status,
        count: response.count,
        headers: response.headers,
    })
}
