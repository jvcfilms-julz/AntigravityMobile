package de.xyourp.antigravitymobile.ui.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import de.xyourp.antigravitymobile.data.AppRepository
import de.xyourp.antigravitymobile.net.Artifact
import de.xyourp.antigravitymobile.net.Conversation
import de.xyourp.antigravitymobile.net.StructuredChat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch

data class ChatState(
    val chat: StructuredChat = StructuredChat(),
    val conversations: List<Conversation> = emptyList(),
    val loading: Boolean = true,
    val sending: Boolean = false,
    val error: String? = null,
    /** Collapse the granular chain-of-thought step timeline. */
    val hideCot: Boolean = false,
    val showConversations: Boolean = false,
    val showNewIdeChatConfirmation: Boolean = false,
    val creatingIdeChat: Boolean = false,
    val actionNotice: String? = null,
    val openArtifact: Artifact? = null,
)

/**
 * Drives the native Chat tab. Polls the bridge's structured conversation model
 * (`/api/chat/structured`) and refreshes on `chat_update` socket events — no
 * WebView. All interactions (send, action buttons, prompt answers, conversation
 * switching, artifact navigation) go through the bridge's existing endpoints.
 */
class ChatViewModel(private val repo: AppRepository) : ViewModel() {

    private val _state = MutableStateFlow(ChatState())
    val state: StateFlow<ChatState> = _state.asStateFlow()

    @Volatile private var refreshing = false

    init {
        viewModelScope.launch { runCatching { repo.api.startChatStream() } }
        load(initial = true)
        loadConversations()
        repo.socket.events.onEach { msg ->
            if (msg.event == "chat_update" || msg.event == "history") load(initial = false)
        }.launchIn(viewModelScope)
    }

    fun load(initial: Boolean) {
        if (refreshing) return
        refreshing = true
        viewModelScope.launch {
            if (initial) _state.value = _state.value.copy(loading = true)
            runCatching { repo.api.chatStructured() }
                .onSuccess { chat ->
                    _state.value = _state.value.copy(
                        chat = chat,
                        loading = false,
                        error = if (chat.found) null else chat.error,
                        // Keep an open artifact in sync with the latest payload.
                        openArtifact = _state.value.openArtifact?.let { if (chat.artifact?.open == true) chat.artifact else null },
                    )
                }
                .onFailure { _state.value = _state.value.copy(loading = false, error = it.message ?: "Failed to load chat") }
            refreshing = false
        }
    }

    fun loadConversations() {
        viewModelScope.launch {
            runCatching { repo.api.chatConversations() }
                .onSuccess { _state.value = _state.value.copy(conversations = it.conversations) }
        }
    }

    fun send(text: String) {
        val msg = text.trim()
        if (msg.isEmpty()) return
        _state.value = _state.value.copy(sending = true)
        viewModelScope.launch {
            runCatching { repo.api.cdpInject(msg, submit = true) }
            _state.value = _state.value.copy(sending = false)
            kotlinx.coroutines.delay(400)
            load(initial = false)
        }
    }

    fun clickAction(xpath: String, label: String) {
        viewModelScope.launch {
            runCatching { repo.api.cdpClick(xpath, label) }
            kotlinx.coroutines.delay(400)
            load(initial = false)
        }
    }

    fun answerOption(optionXpath: String, submitXpath: String?) =
        answer { repo.api.answerPrompt("option", optionXpath = optionXpath, submitXpath = submitXpath) }

    fun answerOther(otherXpath: String, text: String, submitXpath: String?) =
        answer { repo.api.answerPrompt("other", otherXpath = otherXpath, text = text, submitXpath = submitXpath) }

    fun answerSkip(skipXpath: String) =
        answer { repo.api.answerPrompt("skip", skipXpath = skipXpath) }

    private fun answer(call: suspend () -> Unit) {
        viewModelScope.launch {
            runCatching { call() }
            kotlinx.coroutines.delay(400)
            load(initial = false)
        }
    }

    fun toggleCot() { _state.value = _state.value.copy(hideCot = !_state.value.hideCot) }

    fun openConversations() { loadConversations(); _state.value = _state.value.copy(showConversations = true) }
    fun closeConversations() { _state.value = _state.value.copy(showConversations = false) }

    fun switchConversation(id: String) {
        _state.value = _state.value.copy(showConversations = false)
        viewModelScope.launch {
            runCatching { repo.api.switchConversation(id) }
            kotlinx.coroutines.delay(500)
            load(initial = false); loadConversations()
        }
    }

    fun newConversation() {
        _state.value = _state.value.copy(showConversations = false)
        viewModelScope.launch {
            runCatching { repo.api.newConversation() }
            kotlinx.coroutines.delay(500)
            load(initial = false); loadConversations()
        }
    }

    /** A new IDE chat must be explicitly confirmed; never substitute a 2.0 chat. */
    fun requestNewIdeChat() {
        _state.value = _state.value.copy(
            showNewIdeChatConfirmation = true, showConversations = false, actionNotice = null)
    }

    fun cancelNewIdeChat() {
        _state.value = _state.value.copy(showNewIdeChatConfirmation = false)
    }

    fun clearActionNotice() {
        _state.value = _state.value.copy(actionNotice = null)
    }

    fun createNewIdeChat() {
        if (_state.value.creatingIdeChat) return
        _state.value = _state.value.copy(
            showNewIdeChatConfirmation = false, creatingIdeChat = true, actionNotice = null)
        viewModelScope.launch {
            val outcome = runCatching { repo.api.startNewIdeChat() }
            outcome.onSuccess { response ->
                _state.value = _state.value.copy(
                    creatingIdeChat = false,
                    actionNotice = if (response.success) {
                        if (response.verified) "New IDE conversation confirmed"
                        else "New IDE chat requested — verify the new conversation on Screen"
                    } else {
                        response.error ?: "IDE did not open a new conversation"
                    },
                )
                if (response.success) {
                    kotlinx.coroutines.delay(600)
                    load(initial = false)
                    loadConversations()
                }
            }.onFailure { e ->
                _state.value = _state.value.copy(
                    creatingIdeChat = false,
                    actionNotice = "IDE chat request failed: " + (e.message ?: "connection error"),
                )
            }
        }
    }

    fun openArtifact(artifact: Artifact) { _state.value = _state.value.copy(openArtifact = artifact) }
    fun closeArtifact() { _state.value = _state.value.copy(openArtifact = null) }

    fun navArtifact(xpath: String) {
        viewModelScope.launch {
            runCatching { repo.api.cdpClick(xpath, "artifact-nav") }
            kotlinx.coroutines.delay(400)
            load(initial = false)
        }
    }
}
