package de.xyourp.antigravitymobile.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.core.text.HtmlCompat

/**
 * Copies text to the *phone* clipboard; the desktop and Android clipboards are
 * deliberately not kept in continuous sync.
 */
fun copyToPhoneClipboard(context: Context, label: String, text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText(label, text))
}

/**
 * ChatStructured sends sanitized HTML, not Markdown. Copy the actual rendered
 * text (including line breaks) rather than exposing HTML tags to Project Control.
 * For precise Markdown/code handoffs, use the IDE's own Copy action and the
 * Screen tab's explicit PC clipboard transfer.
 */
fun agentResponseText(html: String): String =
    HtmlCompat.fromHtml(html, HtmlCompat.FROM_HTML_MODE_COMPACT).toString().trim()

fun shareAgentResponse(context: Context, text: String) {
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, text)
    }
    context.startActivity(Intent.createChooser(intent, "Share agent response"))
}
