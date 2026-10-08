// SPDX-License-Identifier: Apache-2.0
package Power {
    private import Definitions::*;
    part def Motor :> Component { port powerIn : ~PowerPort; }
    interface def PowerInterface {
        end port supply : PowerPort;
        end port consumer : ~PowerPort;
    }
}
