use std::collections::HashMap;
use std::path::Path as FsPath;
use std::sync::Arc;

use arrow_array::RecordBatchReader;
use lance::dataset::builder::DatasetBuilder;
use lance::dataset::write::CommitBuilder;
use lance::dataset::{ROW_ID, WriteParams};
use lance::io::{ObjectStoreParams, StorageOptionsAccessor};
use lance::{Error, Result};
use object_store::path::Path;

use crate::llm::config::{current_storage_config, muninn_home};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TableStats {
    pub version: u64,
    pub fragment_count: usize,
    pub row_count: usize,
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
        std::fs::create_dir_all(root_path.as_ref()).map_err(|error| {
            Error::io(format!(
                "create storage root {:?}: {error}",
                root_path.as_ref()
            ))
        })?;
        let canonical = std::fs::canonicalize(root_path.as_ref()).map_err(|error| {
            Error::io(format!(
                "canonicalize storage root {:?}: {error}",
                root_path.as_ref()
            ))
        })?;
        Self::from_uri(
            format!("file-object-store://{}", canonical.to_string_lossy()),
            None,
        )
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

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

    fn write_params(&self) -> Option<WriteParams> {
        let mut params = WriteParams {
            enable_stable_row_ids: true,
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
                ..WriteParams::default()
            };
        }
        Some(params)
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

pub(crate) fn escape_predicate_string(value: &str) -> String {
    value.replace('\'', "''")
}
