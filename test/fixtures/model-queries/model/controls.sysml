// SPDX-License-Identifier: Apache-2.0
package Controls {
    private import SafetyExtensions::*;
    alias secure for SafetyExtensions::SafetyRequirementMetadata;
    #secure requirement aliasUse;
    requirement bodyOnly { @SafetyRequirementMetadata; }
    #safety requirement mixed { @SafetyRequirementMetadata; }
    part def SplitReviews {
        @Review { reviewer = "Lead"; approved = false; }
        @Review { reviewer = "Peer"; approved = true; }
    }
    part def AcceptedReview { @Review { reviewer = "Lead"; approved = true; } }
    part def 'Quoted Name' { @Rationale { approvedBy = "Quoted"; } }
}
