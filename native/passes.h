#include <stdexcept>
#include <type_traits>
#include <utility>

// These are scheduling capabilities, not claims that asynchronous validation
// has already completed. Only after the final wait may the host inspect IR.
enum class Phase { Source, LexemeFlags, TokenIR, StructuredTokens, OperatorIR, RawAst, CheckedAst, ResolvedAst, TypedAst };
template<Phase P> class Scheduled;
template<Phase P,typename Encode> auto advance(Scheduled<P>&& input,Encode encode);
inline Scheduled<Phase::Source> beginPipeline();

template<Phase P> class Scheduled {
  bool live=true;
  Scheduled()=default;
  friend Scheduled<Phase::Source> beginPipeline();
  template<Phase Q,typename Encode> friend auto advance(Scheduled<Q>&& input,Encode encode);
public:
  Scheduled(const Scheduled&)=delete;
  Scheduled& operator=(const Scheduled&)=delete;
  Scheduled(Scheduled&& other) noexcept : live(std::exchange(other.live,false)) {}
  void consume() {
    if(!live) throw std::logic_error("Nanopass input was already consumed");
    live=false;
  }
};

inline Scheduled<Phase::Source> beginPipeline() { return {}; }

template<Phase P,typename Encode>
auto advance(Scheduled<P>&& input,Encode encode) {
  static_assert(P!=Phase::TypedAst,"No successor after the final pass");
  input.consume();
  encode();
  return Scheduled<static_cast<Phase>(static_cast<int>(P)+1)>{};
}
static_assert(!std::is_copy_constructible_v<Scheduled<Phase::Source>>);
static_assert(!std::is_default_constructible_v<Scheduled<Phase::CheckedAst>>);
