import "@azure-tools/typespec-azure-core";

using Azure.Core;

#suppress "@azure-tools/typespec-azure-core/auth-required" ""
#suppress "@azure-tools/typespec-azure-core/require-versioned" ""
@service
namespace Azure.Storage.Tables;

/** A generic document entity. */
model Document {
  /** The document identifier. */
  id: string;
  /** The document content. */
  content: string;
}

/** A format specification. */
model Format {
  /** The format type. */
  type: string;
}

/** A storage table entity - this is multi-word so should NOT trigger. */
model TableEntity {
  /** The partition key. */
  partitionKey: string;
  /** The row key. */
  rowKey: string;
}
