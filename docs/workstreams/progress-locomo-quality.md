# LoCoMo Quality TODO

## 2026-05-17

当前 three-small 小样本中，Honcho 口径剩余可优化点：

- [ ] `conv-30 Q10`: extractor 需要保留 prompt 侧的评价、判断、描述性回答。现象是 Gina 的 `They're so graceful` 没有稳定进入 extraction，导致问题 `What does Gina say about the dancers in the photo?` 回答成了上下文里的 `whether they were his`。优化方向应保持泛化：prompt 和 response 都可能包含 remembered content，不应自动把 prompt 侧内容降级为 context。
- [ ] `conv-30 Q3`: extractor / recall 需要更好合并同一决策链里的 trigger、decision、motivation。现象是 `lost job -> start business` 和 `dance studio motivation` 都被召回，但最终答案只覆盖 passion/motivation，漏掉 job loss trigger。
- [ ] 暂不针对 `conv-26 Q4` 做强修。Gold 是 `Transgender woman`，但原文只明确出现 transgender stories、support group、embrace herself；硬推身份会增加身份类幻觉风险。
