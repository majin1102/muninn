use std::collections::HashMap;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;

use arrow_array::RecordBatchReader;
use serde::{Deserialize, Serialize};
use lance::dataset::builder::DatasetBuilder;
use lance::dataset::{ROW_ID, WriteParams};
use lance::io::{ObjectStoreParams, StorageOptionsAccessor};
use lance::{Error, Result};
use object_store::path::Path;

use crate::config::{current_storage_config, muninn_home};

pub(crate) use lance::Dataset as LanceDataset;

#[derive(Debug, Clone)]
pub struct TableOptions {
    root: Path,
    uri_root: String,
    storage_options: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone)]
pub struct TableAccess {
    options: TableOptions,
    path: Path,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableStats {
    pub version: u64,
    pub fragment_count: usize,
    pub row_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableDescription {
    /// Table facts that are directly available from the opened dataset schema.
    pub metadata: HashMap<String, String>,
    /// Field-level metadata surfaced without promising full schema validation.
    pub field_metadata: HashMap<String, HashMap<String, String>>,
    /// Extra dimensions derived by tables that explicitly expose them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dimensions: Option<HashMap<String, usize>>,
}

impl TableOptions {
    pub fn load() -> Result<Self> {
        match current_storage_config()? {
            Some(config) => Self::from_uri(config.uri, config.storage_options),
            None => Self::local(muninn_home()),
        }
    }

    pub fn from_uri(
        uri_root: impl Into<String>,
        storage_options: Option<HashMap<String, String>>,
    ) -> Result<Self> {
        let uri_root = uri_root.into().trim_end_matches('/').to_string();
        if uri_root.is_empty() {
            return Err(Error::invalid_input("storage.uri must not be empty"));
        }
        Ok(Self {
            root: Path::default(),
            uri_root,
            storage_options,
        })
    }

    pub fn local(root_path: impl AsRef<FsPath>) -> Result<Self> {
        let canonical = resolve_local_root(root_path.as_ref(), true)?;
        Self::from_uri(
            format!("file-object-store://{}", canonical.to_string_lossy()),
            None,
        )
    }

    pub fn local_read_only(root_path: impl AsRef<FsPath>) -> Result<Self> {
        let canonical = resolve_local_root(root_path.as_ref(), false)?;
        Self::from_uri(
            format!("file-object-store://{}", canonical.to_string_lossy()),
            None,
        )
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub(crate) fn matches(&self, other: &Self) -> bool {
        self.uri_root == other.uri_root && self.storage_options == other.storage_options
    }

    fn uri_for(&self, path: &Path) -> String {
        if path.as_ref().is_empty() {
            self.uri_root.clone()
        } else {
            let root = self.uri_root.trim_end_matches('/');
            format!("{root}/{}", path.as_ref())
        }
    }

    fn dataset_builder(&self, path: &Path) -> DatasetBuilder {
        let mut builder = DatasetBuilder::from_uri(self.uri_for(path));
        if let Some(storage_options) = self.storage_options.clone() {
            builder = builder.with_storage_options(storage_options);
        }
        builder
    }

    pub(crate) fn write_params(&self) -> Option<WriteParams> {
        let mut params = WriteParams {
            enable_stable_row_ids: true,
            skip_auto_cleanup: true,
            ..WriteParams::default()
        };
        if let Some(storage_options) = self.storage_options.clone() {
            params = WriteParams {
                store_params: Some(ObjectStoreParams {
                    storage_options_accessor: Some(Arc::new(
                        StorageOptionsAccessor::with_static_options(storage_options),
                    )),
                    ..Default::default()
                }),
                enable_stable_row_ids: true,
                skip_auto_cleanup: true,
                ..WriteParams::default()
            };
        }
        Some(params)
    }
}

fn resolve_local_root(root_path: &FsPath, create: bool) -> Result<PathBuf> {
    if create {
        std::fs::create_dir_all(root_path).map_err(|error| {
            Error::io(format!("create storage root {:?}: {error}", root_path))
        })?;
    }

    let absolute = if root_path.is_absolute() {
        root_path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| Error::io(format!("resolve storage root {:?}: {error}", root_path)))?
            .join(root_path)
    };

    match std::fs::canonicalize(&absolute) {
        Ok(canonical) => Ok(canonical),
        Err(error) if !create && error.kind() == std::io::ErrorKind::NotFound => Ok(absolute),
        Err(error) => Err(Error::io(format!(
            "canonicalize storage root {:?}: {error}",
            root_path
        ))),
    }
}

impl TableAccess {
    pub fn new(options: TableOptions, path: Path) -> Self {
        Self { options, path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn options(&self) -> &TableOptions {
        &self.options
    }

    pub(crate) async fn try_open(&self) -> Result<Option<LanceDataset>> {
        match self.options.dataset_builder(&self.path).load().await {
            Ok(dataset) => Ok(Some(dataset)),
            Err(Error::DatasetNotFound { .. } | Error::NotFound { .. }) => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub(crate) async fn write<R>(&self, reader: R) -> Result<LanceDataset>
    where
        R: RecordBatchReader + Send + 'static,
    {
        LanceDataset::write(
            reader,
            &self.options.uri_for(&self.path),
            self.options.write_params(),
        )
        .await
    }

    pub(crate) async fn maintenance_stats(&self) -> Result<Option<TableStats>> {
        let Some(dataset) = self.try_open().await? else {
            return Ok(None);
        };
        Ok(Some(TableStats {
            version: dataset.version().version,
            fragment_count: dataset.get_fragments().len(),
            row_count: dataset.count_rows(None).await?,
        }))
    }
}

pub(crate) fn describe_dataset(dataset: &LanceDataset) -> TableDescription {
    let schema = dataset.schema();
    let field_metadata = schema
        .fields
        .iter()
        .filter_map(|field| {
            let metadata = field.metadata.clone();
            (!metadata.is_empty()).then(|| (field.name.clone(), metadata))
        })
        .collect();
    TableDescription {
        metadata: schema.metadata.clone(),
        field_metadata,
        dimensions: None,
    }
}

pub(crate) async fn delete_by_ids(
    dataset: Option<LanceDataset>,
    column_name: &str,
    ids: Vec<String>,
) -> Result<usize> {
    let Some(mut dataset) = dataset else {
        return Ok(0);
    };
    if ids.is_empty() {
        return Ok(0);
    }
    let predicate = ids
        .iter()
        .map(|id| format!("{column_name} = '{}'", escape_predicate_string(id)))
        .collect::<Vec<_>>()
        .join(" OR ");
    let result = dataset.delete(&predicate).await?;
    Ok(result.num_deleted_rows as usize)
}

pub(crate) async fn delete_by_row_ids(
    dataset: Option<LanceDataset>,
    row_ids: &[u64],
) -> Result<usize> {
    let Some(mut dataset) = dataset else {
        return Ok(0);
    };
    if row_ids.is_empty() {
        return Ok(0);
    }
    let predicate = row_ids
        .iter()
        .map(|row_id| format!("{ROW_ID} = {row_id}"))
        .collect::<Vec<_>>()
        .join(" OR ");
    let result = dataset.delete(&predicate).await?;
    Ok(result.num_deleted_rows as usize)
}

#[cfg(test)]
mod tests {
    use super::TableOptions;

    #[test]
    fn local_read_only_does_not_create_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("missing");
        assert!(!root.exists());

        let options = TableOptions::local_read_only(&root).unwrap();

        assert!(!root.exists());
        assert!(
            options
                .uri_for(options.root())
                .starts_with("file-object-store://")
        );
    }
}

pub(crate) fn escape_predicate_string(value: &str) -> String {
    value.replace('\'', "''")
}
