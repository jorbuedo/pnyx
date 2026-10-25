package expo.modules.modelnative

import com.google.mlkit.genai.schema.guided.GenerableDetail
import com.google.mlkit.genai.schema.guided.GenerableProvider
import kotlin.reflect.KClass
import org.json.JSONObject

/**
 * The shapes this module can constrain decoding to.
 *
 * ### Why a compiled class exists here at all
 *
 * The JS surface takes a schema at runtime, and on iOS that is exactly what happens —
 * `DynamicGenerationSchema` is built per call, so no domain shape reaches the native half.
 * ML Kit has no equivalent: `GenerateTypedContentRequest` takes a `KClass`, and the schema
 * comes from a [GenerableProvider] that ML Kit finds by `ServiceLoader`. So on Android the
 * set of decodable shapes is fixed when the app is compiled, and a caller's schema can only
 * be *matched* against it, never honoured directly.
 *
 * The consequence to know before adding a second one: a new schema on the JS side is not a
 * JS-only change on this platform. It needs a class here, a provider, a line in
 * `src/main/resources/META-INF/services/…GenerableProvider`, and a build.
 *
 * ### Why the provider is written out rather than generated
 *
 * `genai-schema-compiler` is a KSP processor that would derive it from `@Generable` /
 * `@Guide` annotations. It is deliberately not used: it is an alpha, build-time-only
 * dependency and a whole code generator, and its entire output is the constant below.
 * The annotations are gone with it — keeping them beside a hand-written provider would be
 * two declarations of the same schema, and the decorative one would eventually win an
 * argument it should not be in. ML Kit's runtime never reads them; only the processor did.
 *
 * ⚠️ [EXPLANATION_FIELDS] is the single description of this schema. It drives the provider
 * *and* [matchesExplanationSchema], so those two cannot disagree. What it cannot check is
 * [Explanation] itself: **the constructor below must list the same names, in the same order,
 * with the same nullability.** That is the one pairing to keep in step by hand.
 *
 * The `description` strings are duplicated from `explainSchema()` in
 * `app/src/services/explain/structured.ts` — that copy drives iOS, this one drives
 * Android. [matchesExplanationSchema] guards the part that must not drift silently (names,
 * types, the direction vocabulary, optionality); wording differences are tolerated because
 * they are guidance, not contract.
 */
data class Explanation(
  val direction: String,
  val summary: String,
  val cost: String,
  val safety: String?,
)

private class Field(
  val name: String,
  val nullable: Boolean,
  val description: String,
  val enumValues: Array<String>? = null,
)

private val EXPLANATION_FIELDS =
  listOf(
    Field(
      name = "direction",
      nullable = false,
      description = "What happened to the owner: sent, received, feeOnly, or mixed.",
      enumValues = arrayOf("sent", "received", "feeOnly", "mixed"),
    ),
    Field(
      name = "summary",
      nullable = false,
      description = "One plain sentence: what this transaction accomplished for the owner.",
    ),
    Field(
      name = "cost",
      nullable = false,
      description =
        "A complete sentence naming the network fee and saying it is already part of the total, " +
          "not an extra charge. Not a bare amount.",
    ),
    Field(
      name = "safety",
      nullable = true,
      description = "A complete sentence restating the SAFETY line in plain words. Empty when there is no SAFETY line.",
    ),
  )

/**
 * Found by ML Kit through `ServiceLoader`, so it needs the no-argument constructor it has and
 * the registration in `src/main/resources/META-INF/services/`. Without that resource in the
 * APK this fails only at generation time, on a device — there is no compile-time signal.
 */
class ExplanationProvider : GenerableProvider {
  override val targetClass: KClass<*> = Explanation::class

  override fun getGenerableDetail(): GenerableDetail<*> = DETAIL

  private companion object {
    val DETAIL =
      GenerableDetail<Explanation>(
        description = "A plain-language explanation of one Cardano transaction for its owner.",
        guideDetails =
          EXPLANATION_FIELDS.map { field ->
            GenerableDetail.GuideDetail(
              name = field.name,
              type = String::class,
              nullable = field.nullable,
              isList = false,
              listItemType = null,
              description = field.description,
              maxItems = null,
              minItems = null,
              maximum = null,
              minimum = null,
              enumValues = field.enumValues,
            )
          },
      )
  }
}

/**
 * Whether the caller's runtime schema is the shape [Explanation] was compiled for.
 *
 * Structural, not cosmetic. The point is to fail loudly when the TS schema gains a field,
 * renames one, or changes the `direction` vocabulary — because `composeStructuredExplanation`
 * checks `direction` against the facts, and a value this class cannot produce would turn
 * that check into a permanent rejection with no obvious cause.
 */
fun matchesExplanationSchema(schema: JSONObject): Boolean {
  if (schema.optString("type") != "object" || schema.optString("name") != "Explanation") return false
  val properties = schema.optJSONArray("properties") ?: return false
  if (properties.length() != EXPLANATION_FIELDS.size) return false

  for ((index, field) in EXPLANATION_FIELDS.withIndex()) {
    val property = properties.optJSONObject(index) ?: return false
    if (property.optString("name") != field.name) return false
    if (property.optBoolean("optional", false) != field.nullable) return false

    val inner = property.optJSONObject("schema") ?: return false
    val expectedValues = field.enumValues
    if (expectedValues == null) {
      if (inner.optString("type") != "string") return false
    } else {
      if (inner.optString("type") != "enum") return false
      val values = inner.optJSONArray("values") ?: return false
      if (values.length() != expectedValues.size) return false
      for (position in expectedValues.indices) if (values.optString(position) != expectedValues[position]) return false
    }
  }
  return true
}

/**
 * Serialised back to JSON rather than bridged as a record.
 *
 * The JS side parses one string, so there is a single place the shape is written and a
 * single place it is read. `safety` is omitted rather than sent as null when the model left
 * it out — the caller treats an absent field and an empty one identically, and omitting
 * keeps the payload honest about what the model actually produced.
 */
fun Explanation.toJson(): String =
  JSONObject()
    .put("direction", direction)
    .put("summary", summary)
    .put("cost", cost)
    .apply { safety?.let { put("safety", it) } }
    .toString()
