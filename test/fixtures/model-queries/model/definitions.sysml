// SPDX-License-Identifier: Apache-2.0
package Definitions {
    private import ScalarValues::Real;
    port def PowerPort { out attribute voltage : Real; }
    part def Component { attribute mass : ISQ::MassValue; }
    part def PowerSource :> Component { port power : PowerPort; }
    part def Battery :> PowerSource {
        doc /* A battery supplying electrical power. */
        attribute capacity : Real;
    }
}
