#[allow(dead_code)]
mod generated {
    include!("fixtures/generated.rs");
}

#[test]
fn generated_models_preserve_omission_null_defaults_and_decimal_precision() {
    use generated::public::notes::{EnumColumn5, Insert, Row, Update};
    use nelcota_client::Field;
    let insert = Insert {
        body: "hello".into(),
        extra: Field::Omit,
        price: Field::Omit,
        tags: Field::Omit,
        r#type: Field::Value(EnumColumn5::HighPriority),
        field_self: Field::Omit,
        field_self_2: Field::Omit,
        x_u1b_: Field::Omit,
    };
    let json = serde_json::to_value(insert).unwrap();
    assert_eq!(
        json,
        serde_json::json!({"body":"hello","type":"high-priority"})
    );
    let update = Update {
        extra: Field::Value(None),
        ..Default::default()
    };
    assert_eq!(
        serde_json::to_value(update).unwrap(),
        serde_json::json!({"extra":null})
    );
    let row: Row = serde_json::from_str(r#"{"id":9223372036854775807,"body":"hello","extra":null,"price":12345678901234567890.123456789,"tags":["a",null],"type":"low","Self":null,"field_self":null,"x\u001b":null}"#).unwrap();
    assert_eq!(row.id, i64::MAX);
    assert_eq!(row.price.to_string(), "12345678901234567890.123456789");
    assert!(row.tags[1].is_none());
    let update: Update = serde_json::from_str(r#"{"extra":null}"#).unwrap();
    assert_eq!(update.extra, Field::Value(None));
    assert!(update.body.is_omitted());
    let args = generated::public::rpc::add::Args {
        a: Some(2),
        b: Field::Omit,
    };
    assert_eq!(
        serde_json::to_value(args).unwrap(),
        serde_json::json!({"a":2})
    );
}
