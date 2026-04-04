use super::*;

impl Sessions<'_> {
    pub async fn post(&self, message: PostMessage) -> Result<SessionTurn> {
        let observer = effective_observer_name()?;
        let key = SessionKey::from_parts(message.session_id.as_deref(), &message.agent, &observer);
        let session_write_lock = self.muninn.session_write_lock(&key).await;
        let turn = {
            let _session_guard = session_write_lock.lock().await;
            let mut session = self.muninn.load_session(key).await?;
            let guard = self.muninn.observer.begin_post();
            let preview_prompt = session.preview_prompt(message.prompt.as_deref());
            let metadata = resolve_turn_metadata(
                preview_prompt.as_deref(),
                message.title.clone(),
                message.summary.clone(),
                message.response.as_deref(),
            )
            .await;
            let update = SessionUpdate {
                session_id: message.session_id,
                agent: message.agent,
                observer,
                title: metadata.title,
                summary: metadata.summary,
                title_source: metadata.title_source,
                summary_source: metadata.summary_source,
                tool_calling: message.tool_calling,
                artifacts: message.artifacts,
                prompt: message.prompt,
                response: message.response,
            };
            update.validate()?;

            let mut observable_turns = Vec::new();
            let table = self.muninn.session_table();
            let turn =
                if let Some(mut sealed_turn) = session.apply(update)? {
                    if sealed_turn.observable() {
                        sealed_turn.observing_epoch = Some(guard.epoch());
                    }
                    table.upsert(vec![sealed_turn.clone()]).await?;
                    let persisted = table.load_latest_turn(session.key()).await?.ok_or_else(|| {
                    lance::Error::invalid_input(
                        "sealed turn write completed but persisted row could not be reloaded",
                    )
                })?;
                    if persisted.observable() {
                        observable_turns.push(persisted.clone());
                    }
                    persisted
                } else {
                    let open_turn = session.open_turn().cloned().ok_or_else(|| {
                        lance::Error::invalid_input("session apply completed without an open turn")
                    })?;
                    table.upsert(vec![open_turn.clone()]).await?;
                    let persisted =
                        table.load_open_turn(session.key()).await?.ok_or_else(|| {
                            lance::Error::invalid_input(
                                "open turn write completed but persisted row could not be reloaded",
                            )
                        })?;
                    session = Session::new(session.key().clone(), Some(persisted.clone()))?;
                    persisted
                };
            self.muninn.store_session(session).await;
            self.muninn.observer.enqueue(observable_turns).await;
            guard.complete();
            turn
        };
        Ok(turn)
    }

    pub async fn list(&self, list: SessionList) -> Result<Vec<SessionTurn>> {
        memory_sessions::list(
            self.muninn.table_options(),
            SessionListQuery {
                mode: list.mode,
                agent: list.agent,
                session_id: list.session_id,
            },
        )
        .await
    }

    pub async fn get(&self, memory_id: &str) -> Result<Option<SessionTurn>> {
        memory_sessions::get(self.muninn.table_options(), &memory_id.parse()?).await
    }
}
